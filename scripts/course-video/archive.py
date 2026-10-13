"""Local Quercus/Kaltura archive. Authentication stays in a dedicated browser.

Default operation inventories metadata, never downloads video. The browser
profile is local, contains login state, and must not be uploaded with archives.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import shutil
import sys
import time
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse, urlunparse

runtime_stage = "arguments"


def safe_runtime_failure(error):
    message = str(error).lower()
    patterns = {"READ_ONLY_RUNTIME": r"read-only file system", "RUNTIME_PERMISSION": r"permission denied|eacces",
                "DISPLAY_UNAVAILABLE": r"missing x server|\$display|cannot open display",
                "BROWSER_NOT_INSTALLED": r"executable doesn't exist", "CRASHPAD_RUNTIME": r"crashpad",
                "BROWSER_SANDBOX": r"no usable sandbox|without --no-sandbox", "TIMEOUT": r"timeout"}
    code = next((key for key, pattern in patterns.items() if re.search(pattern, message)), "RUNTIME_FAILURE")
    return {"state": "runtime_failure", "stage": runtime_stage, "exceptionType": type(error).__name__, "code": code}


class ReauthRequired(Exception):
    pass


class MediaAPIError(Exception):
    def __init__(self, code, status, origin, service, action):
        self.details = {"code": code if re.fullmatch(r"[A-Z0-9_]{1,100}", str(code)) else "API_REJECTED",
                        "httpStatus": status, "originHost": urlparse(origin).hostname,
                        "service": service, "action": action}
        super().__init__(self.details["code"])


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def atomic_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def response_json(response):
    """Canvas cookie-auth responses may carry the official XSSI guard."""
    body = response.text().lstrip("\ufeff \r\n\t")
    for prefix in ("while(1);", "while (1);", ")]}'"):
        if body.startswith(prefix):
            body = body[len(prefix):].lstrip("\r\n ,;")
            break
    return json.loads(body)


def public_url(value: str) -> str:
    """Never persist query strings, fragment tokens or /ks/<session> paths."""
    parsed = urlparse(value)
    path = re.sub(r"/ks/[^/]+", "/ks/[redacted]", parsed.path, flags=re.I)
    return urlunparse((parsed.scheme, parsed.netloc, path, "", "", ""))


def media_host(host: str, extra: set[str]) -> bool:
    host = host.lower()
    return host == "kaltura.com" or host.endswith(".kaltura.com") or host in extra


def fields(value):
    """Walk JSON/form multirequests; do not return opaque browser cookies."""
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from fields(child)
    elif isinstance(value, list):
        for child in value:
            yield from fields(child)


def parse_request(url: str, body: str | None) -> dict:
    result = {key: values[-1] for key, values in parse_qs(urlparse(url).query).items()}
    pieces = urlparse(url).path.strip("/").split("/")
    for index in range(len(pieces) - 1):
        if pieces[index] in ("ks", "entry_id", "entryId", "p", "partner_id", "wid"):
            result[pieces[index]] = unquote(pieces[index + 1])
    if body:
        try:
            result.update(json.loads(body))
        except (ValueError, TypeError):
            result.update({key: values[-1] for key, values in parse_qs(body).items()})
    return result


class Sessions:
    def __init__(self, extra_hosts: set[str]):
        self.extra_hosts = extra_hosts
        self.entries: dict[str, dict] = {}
        self.session_by_origin: dict[str, str] = {}
        self.session_sources: dict[str, str] = {}
        self.current_course = ""
        self.current_page = ""
        self.channels: dict[str, set[str]] = {}

    def remember_channel(self, url: str):
        parsed = urlparse(url)
        if not media_host(parsed.hostname or "", self.extra_hosts):
            return
        category = re.search(r"/(?:categoryid|categoryId)/(\d+)(?:/|$)", parsed.path)
        if not category:
            category = re.search(r"/media/(?:[^/]+/)*[01]_[A-Za-z0-9]+/(\d+)(?:/|$)", parsed.path)
        if category:
            self.channels.setdefault(self.current_course, set()).add(category.group(1))

    def observe_request(self, request):
        parsed = urlparse(request.url)
        if parsed.scheme != "https" or not media_host(parsed.hostname or "", self.extra_hosts):
            return
        self.remember_channel(request.url)
        origin = f"https://{parsed.netloc}"
        payload = parse_request(request.url, request.post_data)
        dictionaries = list(fields(payload))
        session = next((str(item[key]) for item in dictionaries for key in item
                        if (key.lower() in ("ks", "flashvars[ks]") or key.lower().endswith(":ks"))
                        and item[key] and not str(item[key]).startswith("{")), None)
        if session:
            self.session_by_origin[f"{self.current_course}:{origin}"] = session
            self.session_sources[f"{self.current_course}:{origin}"] = "observed_request_literal"
        for item in dictionaries:
            for key, value in item.items():
                if key.lower() in ("entryid", "entry_id", "filter:entryidequal") or key.lower().endswith(":entryid"):
                    if isinstance(value, str) and re.fullmatch(r"[01]_[A-Za-z0-9]+", value):
                        self.remember(value, origin, session)

    def remember(self, entry: str, origin: str, session: str | None):
        key = f"{self.current_course}:{entry}"
        old = self.entries.get(key, {})
        self.entries[key] = {**old, "entryId": entry, "courseId": self.current_course,
                             "origin": origin, "ks": session or old.get("ks"),
                             "sourceUrl": public_url(self.current_page)}

    def observe_response(self, response):
        parsed = urlparse(response.url)
        if parsed.scheme != "https" or not media_host(parsed.hostname or "", self.extra_hosts):
            return
        if "json" not in response.headers.get("content-type", ""):
            return
        try:
            data = response.json()
        except Exception:
            return
        origin = f"https://{parsed.netloc}"
        for item in fields(data):
            # Response-issued KS covers bootstrap/multirequest session start.
            if isinstance(item.get("ks"), str):
                self.session_by_origin[f"{self.current_course}:{origin}"] = item["ks"]
                self.session_sources[f"{self.current_course}:{origin}"] = "observed_response_session"
            if item.get("objectType") in ("KalturaMediaEntry", "KalturaBaseEntry") and re.fullmatch(r"[01]_[A-Za-z0-9]+", str(item.get("id", ""))):
                self.remember(item["id"], origin, self.session_by_origin.get(f"{self.current_course}:{origin}"))

    def usable(self, value: dict) -> dict:
        return {**value, "ks": value.get("ks") or self.session_by_origin.get(f"{value['courseId']}:{value['origin']}")}


class QuietLogger:
    def debug(self, _message):
        pass

    def warning(self, _message):
        pass

    def error(self, _message):
        pass


def kaltura_api(context, session: dict, service: str, action: str, **parameters):
    if not session.get("ks"):
        raise ReauthRequired()
    response = context.request.post(session["origin"] + "/api_v3/service/" + service + "/action/" + action,
                                    form={"ks": session["ks"], "format": "1", **parameters}, timeout=60000)
    if response.status in (401, 403):
        raise MediaAPIError("AUTHORIZATION_DENIED", response.status, session["origin"], service, action)
    if not response.ok:
        raise MediaAPIError("HTTP_FAILURE", response.status, session["origin"], service, action)
    try:
        result = response_json(response)
    except (ValueError, TypeError):
        raise MediaAPIError("NON_JSON_RESPONSE", response.status, session["origin"], service, action) from None
    if isinstance(result, dict) and result.get("objectType") == "KalturaAPIException":
        raise MediaAPIError(result.get("code", "API_REJECTED"), response.status, session["origin"], service, action)
    return result


def inventory_entry(context, session: dict, include_captions: bool = False) -> tuple[dict, dict]:
    info = kaltura_api(context, session, "baseentry", "get", entryId=session["entryId"])
    if not isinstance(info, dict) or info.get("id") != session["entryId"]:
        raise RuntimeError("media_identity_mismatch")
    flavors = kaltura_api(context, session, "flavorasset", "getbyentryid", entryId=session["entryId"])
    if isinstance(flavors, dict):
        flavors = flavors.get("objects", [])
    if not isinstance(flavors, list) or any(item.get("entryId") != session["entryId"] for item in flavors):
        raise RuntimeError("flavor_identity_mismatch")
    captions = []
    page = 1
    while include_captions:
        batch = kaltura_api(context, session, "caption_captionasset", "list", **{
            "filter:entryIdEqual": session["entryId"], "pager:pageSize": "100", "pager:pageIndex": str(page)})
        objects = batch.get("objects", [])
        if any(item.get("entryId") != session["entryId"] for item in objects):
            raise RuntimeError("caption_identity_mismatch")
        captions.extend(objects)
        if len(captions) >= int(batch.get("totalCount", len(captions))) or not objects:
            break
        page += 1
        if page > 100:
            raise RuntimeError("caption_pagination_limit")
    formats = []
    for flavor in flavors:
        if flavor.get("status") != 2 or flavor.get("fileExt") in ("wvm", "chun"):
            continue
        formats.append({"format_id": str(flavor["id"]), "ext": flavor.get("fileExt") or "mp4",
                        "height": flavor.get("height"), "width": flavor.get("width"),
                        "tbr": flavor.get("bitrate"), "filesize_approx": int(flavor.get("size") or 0) * 1024,
                        "preference": 10 if flavor.get("isOriginal") else 0,
                        "url": info["dataUrl"].rstrip("/") + "/flavorId/" + flavor["id"] + "/ks/" + session["ks"]})
    stable_id = hashlib.sha256(f"{info.get('partnerId')}:{session['entryId']}:{session['courseId']}".encode()).hexdigest()
    track = "unknown"
    # A parent-child relationship establishes stream identity, not the content
    # of the picture. Classify only explicit publisher-provided stream labels.
    name = str(info.get("name", ""))
    if re.search(r"\b(screen|slides|presentation|desktop)\b", name, re.I):
        track = "screen"
    elif re.search(r"\b(camera|webcam|presenter)\b", name, re.I):
        track = "camera"
    public = {"entryId": session["entryId"], "partnerId": info.get("partnerId"), "stableId": stable_id,
              "track": track, "parentEntryId": info.get("parentEntryId") or session.get("parentEntryId"),
              "trackRelation": session.get("trackRelation"), "temporaryDownloadAvailable": bool(formats),
              "courseId": session["courseId"], "sourceUrl": session["sourceUrl"], "channelId": session.get("channelId"),
              "title": info.get("name", session["entryId"]),
              "durationSeconds": info.get("duration"), "publishedAt": info.get("createdAt"),
              "updatedAt": info.get("updatedAt"), "formats": [{key: value for key, value in item.items() if key != "url"} for item in formats],
              "captions": [{key: item.get(key) for key in ("id", "languageCode", "language", "format", "fileExt", "status", "updatedAt")}
                           for item in captions], "seenAt": int(time.time()), "state": "discovered"}
    return public, {"formats": formats, "captions": captions}


def child_streams(context, session: dict, max_pages: int) -> list[dict]:
    """Official read-only parentEntryIdEqual filter; never assumes one stream."""
    children = []
    for page in range(1, max_pages + 1):
        result = kaltura_api(context, session, "baseentry", "list", **{
            "filter:objectType": "KalturaBaseEntryFilter", "filter:parentEntryIdEqual": session["entryId"],
            "pager:pageSize": "100", "pager:pageIndex": str(page)})
        objects = result.get("objects", [])
        for item in objects:
            entry = str(item.get("id", ""))
            if not re.fullmatch(r"[01]_[A-Za-z0-9]+", entry) or item.get("parentEntryId") != session["entryId"]:
                raise RuntimeError("invalid_child_stream_relation")
            children.append({**session, "entryId": entry, "parentEntryId": session["entryId"],
                             "trackRelation": {"method": "baseentry.list.parentEntryIdEqual",
                                               "parentEntryId": session["entryId"], "childEntryId": entry}})
        if len(children) >= int(result.get("totalCount", len(children))) or not objects:
            return children
    raise RuntimeError("child_stream_pagination_limit")


def channel_entries(context, session: dict, category: str, max_pages: int) -> tuple[list[str], int]:
    entries = []
    expected = None
    for page in range(1, max_pages + 1):
        result = kaltura_api(context, session, "categoryentry", "list", **{
            "filter:objectType": "KalturaCategoryEntryFilter", "filter:categoryIdEqual": category,
            "filter:statusEqual": "2", "pager:pageSize": "100", "pager:pageIndex": str(page)})
        total = int(result.get("totalCount", -1))
        if total < 0 or expected is not None and total != expected:
            raise RuntimeError("channel_changed_during_scan")
        expected = total
        objects = result.get("objects", [])
        for item in objects:
            entry = str(item.get("entryId", ""))
            if str(item.get("categoryId")) != category or not re.fullmatch(r"[01]_[A-Za-z0-9]+", entry):
                raise RuntimeError("invalid_channel_membership")
            entries.append(entry)
        if len(entries) >= total:
            if len(set(entries)) != total:
                raise RuntimeError("channel_count_mismatch")
            return entries, total
        if not objects:
            raise RuntimeError("channel_pagination_incomplete")
    raise RuntimeError("channel_pagination_limit")


def verified_files(root: Path, record: dict) -> bool:
    files = record.get("files", [])
    for item in files:
        path = (root / item["path"]).resolve()
        if not path.is_relative_to(root.resolve()) or not path.is_file() or sha256(path) != item["sha256"]:
            return False
    return bool(files)


def archive_entry(context, session: dict, metadata: dict, private: dict, root: Path, subtitles_only: bool, include_captions: bool = False) -> list[dict]:
    revision = str(metadata.get("updatedAt") or metadata.get("publishedAt") or "unknown")
    if not re.fullmatch(r"[0-9]+|unknown", revision):
        raise RuntimeError("invalid_media_revision")
    directory = root / session["courseId"] / session["entryId"] / ("version-" + revision)
    directory.mkdir(parents=True, exist_ok=True)
    files = []
    for caption in private["captions"] if include_captions else []:
        if caption.get("status") != 2:
            continue
        extension = {1: "srt", 2: "ttml", 3: "vtt"}.get(caption.get("format"), "ttml")
        if not re.fullmatch(r"[A-Za-z0-9_]+", str(caption.get("id", ""))):
            raise RuntimeError("invalid_caption_id")
        destination = directory / (caption["id"] + "." + extension)
        response = context.request.get(session["origin"] + "/api_v3/service/caption_captionasset/action/serve/captionAssetId/" + caption["id"],
                                       params={"ks": session["ks"]}, timeout=60000)
        if response.status in (401, 403):
            raise ReauthRequired()
        if not response.ok:
            raise RuntimeError("caption_download_failed")
        content = response.body()
        if not content or b"KalturaAPIException" in content[:2000] or b"<html" in content[:200].lower():
            raise ReauthRequired()
        # Preserve old caption bytes even if Kaltura replaces an asset in place.
        destination = destination.with_name(destination.stem + "-" + hashlib.sha256(content).hexdigest()[:16] + destination.suffix)
        temporary = destination.with_suffix(destination.suffix + ".part")
        temporary.write_bytes(content)
        temporary.replace(destination)
        files.append({"kind": "caption", "path": str(destination.relative_to(root)), "sha256": sha256(destination),
                      "bytes": destination.stat().st_size, "language": caption.get("languageCode") or caption.get("language") or "und",
                      "captionId": caption["id"], "format": extension})
    if not subtitles_only:
        if not private["formats"]:
            raise RuntimeError("no_authorized_download_format")
        maximum = max(item.get("filesize_approx", 0) for item in private["formats"])
        if shutil.disk_usage(root).free < maximum + 512 * 1024 * 1024:
            raise RuntimeError("insufficient_local_storage")
        import yt_dlp
        last_storage_check = 0
        def guard_storage(progress):
            nonlocal last_storage_check
            if progress.get("status") == "downloading" and time.monotonic() - last_storage_check > 2:
                last_storage_check = time.monotonic()
                if shutil.disk_usage(root).free < 512 * 1024 * 1024:
                    raise RuntimeError("insufficient_local_storage")
        # yt-dlp's public Kaltura extractor starts a widget KS itself. Supplying
        # already-authorized formats avoids replacing the browser's scoped KS.
        with yt_dlp.YoutubeDL({"logger": QuietLogger(), "quiet": True, "no_warnings": True,
                              "outtmpl": str(directory / "original.%(ext)s"), "continuedl": True,
                              "retries": 3, "fragment_retries": 3, "concurrent_fragment_downloads": 1,
                              "writeinfojson": False, "noprogress": True, "progress_hooks": [guard_storage]}) as downloader:
            result = downloader.process_ie_result({"id": session["entryId"], "title": metadata["title"],
                                                    "formats": private["formats"]}, download=True)
            filename = Path(result.get("filepath") or downloader.prepare_filename(result))
        if not filename.is_file() or filename.stat().st_size == 0:
            raise RuntimeError("video_download_incomplete")
        files.append({"kind": "video", "path": str(filename.relative_to(root)), "sha256": sha256(filename), "bytes": filename.stat().st_size})
    return files


def canvas_pages(context, base: str, endpoint: str, max_pages: int):
    url = base + endpoint
    for _ in range(max_pages):
        response = context.request.get(url, timeout=60000)
        if response.status in (401, 403) or "/login" in response.url:
            raise ReauthRequired()
        if not response.ok or "json" not in response.headers.get("content-type", ""):
            raise RuntimeError("canvas_inventory_failed")
        yield from response_json(response)
        next_url = next((part.split(">", 1)[0].strip().lstrip("<") for part in response.headers.get("link", "").split(",") if 'rel="next"' in part), None)
        if not next_url:
            return
        if urlparse(next_url).netloc != urlparse(base).netloc:
            raise RuntimeError("unexpected_pagination_host")
        url = next_url
    raise RuntimeError("canvas_pagination_limit")


def course_targets(context, base: str, course: str, max_pages: int) -> list[str]:
    targets = [f"{base}/courses/{course}"]
    for module in canvas_pages(context, base, f"/api/v1/courses/{course}/modules?per_page=100", max_pages):
        for item in canvas_pages(context, base, f"/api/v1/courses/{course}/modules/{module['id']}/items?per_page=100", max_pages):
            if item.get("html_url"):
                targets.append(item["html_url"])
    for item in canvas_pages(context, base, f"/api/v1/courses/{course}/pages?per_page=100", max_pages):
        if item.get("html_url"):
            targets.append(item["html_url"])
    for item in canvas_pages(context, base, f"/api/v1/courses/{course}/discussion_topics?only_announcements=true&per_page=100", max_pages):
        if item.get("html_url"):
            targets.append(item["html_url"])
    for tool in canvas_pages(context, base, f"/api/v1/courses/{course}/external_tools?per_page=100", max_pages):
        if re.search(r"kaltura|media gallery|course media|recording", str(tool.get("name", "")), re.I):
            targets.append(f"{base}/courses/{course}/external_tools/{tool['id']}")
    return list(dict.fromkeys(targets))


def inspect_target(page, url: str, sessions: Sessions, max_pages: int, settle_ms: int, navigate: bool = True) -> bool:
    sessions.current_page = url
    if navigate:
        page.goto(url, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(settle_ms)
    if "/login" in page.url:
        raise ReauthRequired()
    visited = set()
    for _ in range(max_pages):
        more = False
        for frame in list(page.frames):
            try:
                frame_url = urlparse(frame.url)
                if not media_host(frame_url.hostname or "", sessions.extra_hosts):
                    continue
                sessions.remember_channel(frame.url)
                # Load per-entry pages to obtain an applicable session/context.
                anchors = frame.locator('a[href*="/entryid/"], a[href*="/entry_id/"], a[href*="/media/"]').evaluate_all("nodes => nodes.map(n => n.href)")
                for href in anchors:
                    sessions.remember_channel(href)
                    target = urlparse(href)
                    if target.scheme != "https" or not media_host(target.hostname or "", sessions.extra_hosts) or href in visited:
                        continue
                    visited.add(href)
                    child = page.context.new_page()
                    try:
                        child.goto(href, wait_until="domcontentloaded", timeout=60000)
                        child.wait_for_timeout(settle_ms)
                    finally:
                        child.close()
                next_button = frame.locator('a[rel="next"], button[aria-label="Next"], a[aria-label="Next"], .pagination-next a')
                if next_button.count() and next_button.first.is_visible() and next_button.first.is_enabled():
                    next_button.first.click()
                    page.wait_for_timeout(settle_ms)
                    more = True
            except ReauthRequired:
                raise
            except Exception:
                return False
        if not more:
            return True
    return False


def main():
    global runtime_stage
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--course-url", action="append", required=True)
    parser.add_argument("--all-courses", action="store_true", help="Enumerate all visible student courses on the same Canvas instance")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--profile", type=Path, help="Optional dedicated persistent profile; default session is ephemeral")
    parser.add_argument("--media-host", action="append", default=[], help="Explicit university Kaltura custom hostname, if applicable")
    parser.add_argument("--download", action="store_true", help="Explicitly archive discovered media; default is metadata only")
    parser.add_argument("--subtitles-only", action="store_true")
    parser.add_argument("--with-captions", action="store_true", help="Opt in to platform subtitle discovery/download after video acceptance")
    parser.add_argument("--pause-after-inventory", action="store_true", help="With --download, keep this login alive for an operator to review the manifest before continuing")
    parser.add_argument("--max-pages", type=int, default=100)
    parser.add_argument("--settle-ms", type=int, default=2500)
    parser.add_argument("--limit", type=int, default=0, help="Bound first download trial; zero means all discovered entries")
    parser.add_argument("--target-only", action="store_true", help="Visit only supplied pages for a first authorized sample")
    parser.add_argument("--channel-id", help="Explicit observed Kaltura channel for a single-course acceptance scope")
    parser.add_argument("--probe", action="store_true", help="Read-only scoped API origin/permission diagnosis; never downloads")
    parser.add_argument("--headless", action="store_true", help="Official Chromium headless shell on the server")
    parser.add_argument("--interactive-server", action="store_true", help="Normal headed Chromium in a temporary server display, with manual verification")
    parser.add_argument("--launch-url-stdin", action="store_true", help="Read a Canvas-authorized sessionless launch JSON from stdin; never log or persist the URL")
    parser.add_argument("--login-timeout", type=int, default=900, help="Seconds allowed for interactive school login and Duo")
    args = parser.parse_args()
    urls = [urlparse(value) for value in args.course_url]
    host = urls[0].netloc
    if any(value.scheme != "https" or value.netloc != host or not re.match(r"^/courses/\d+", value.path) or value.username for value in urls):
        parser.error("Provide HTTPS Canvas course URLs from one instance")
    if args.max_pages < 1 or args.settle_ms < 0 or args.limit < 0 or args.login_timeout < 1:
        parser.error("Invalid limits")
    if args.pause_after_inventory and not args.download:
        parser.error("--pause-after-inventory requires --download")
    if args.channel_id and (not args.channel_id.isdigit() or args.all_courses):
        parser.error("--channel-id requires one numeric channel and a single-course run")
    if args.probe and args.download:
        parser.error("--probe cannot download")
    if args.headless and args.interactive_server:
        parser.error("Choose headless or interactive server mode")
    if args.launch_url_stdin and (not (args.headless or args.interactive_server) or not args.target_only or args.all_courses or len(urls) != 1 or args.pause_after_inventory):
        parser.error("Server launch requires a server browser mode, --target-only and one course")
    if (args.headless or args.interactive_server) and not args.launch_url_stdin:
        parser.error("Server browser mode requires an authorized launch from stdin")
    if args.interactive_server and not args.profile:
        parser.error("Interactive server mode requires its own server-only --profile directory")
    launch_url = None
    if args.launch_url_stdin:
        runtime_stage = "read_authorized_launch_input"
        payload = json.loads(sys.stdin.buffer.read(262144))
        launch_url = payload.get("launchUrl") or payload.get("url")
        parsed_launch = urlparse(launch_url) if isinstance(launch_url, str) else None
        if not parsed_launch or parsed_launch.scheme != "https" or parsed_launch.netloc != host or parsed_launch.username or parsed_launch.password:
            parser.error("Authorized launch must use the configured Canvas HTTPS host")
    root = args.output.resolve()
    profile = args.profile.resolve() if args.profile else None
    if profile and (profile == root or root in profile.parents or profile in root.parents):
        parser.error("Browser profile and archive must be separate directories")
    root.mkdir(parents=True, exist_ok=True)
    if args.download and not args.subtitles_only and importlib.util.find_spec("yt_dlp") is None:
        print("yt-dlp is required for video downloads; install requirements.txt in this Python environment before login.", file=sys.stderr)
        return 2
    if args.download and shutil.disk_usage(root).free < 512 * 1024 * 1024:
        print("Insufficient free space for archive; keep at least 512 MiB reserve.", file=sys.stderr)
        return 2
    path = root / "manifest.json"
    manifest = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"version": 1, "entries": {}}
    sessions = Sessions({value.lower() for value in args.media_host})
    runtime_stage = "import_browser_runtime"
    from playwright.sync_api import sync_playwright
    with sync_playwright() as playwright:
        browser = None
        runtime_stage = "start_browser_context"
        if profile:
            launch_options = {"headless": args.headless}
            if not (args.headless or args.interactive_server):
                launch_options["channel"] = "msedge"
            context = playwright.chromium.launch_persistent_context(str(profile), **launch_options)
        else:
            launch_options = {"headless": args.headless}
            if not (args.headless or args.interactive_server):
                launch_options["channel"] = "msedge"
            browser = playwright.chromium.launch(**launch_options)
            context = browser.new_context()
        # Observe manifest/session requests but avoid streaming whole lectures
        # during metadata collection. Direct yt-dlp download is independent.
        if args.headless or args.interactive_server:
            context.route("**/*", lambda route: route.abort() if route.request.resource_type == "media" else route.continue_())
        context.on("request", sessions.observe_request)
        context.on("response", sessions.observe_response)
        document_responses = []
        def record_document_response(response):
            if response.request.resource_type == "document" and media_host(urlparse(response.url).hostname or "", sessions.extra_hosts):
                details = {"httpStatus": response.status, "originHost": urlparse(response.url).hostname}
                if response.status == 403:
                    try:
                        body = response.body()[:1024 * 1024]
                        text = body.decode("utf-8", errors="replace").lower()
                        details["bodyBytesRead"] = len(body)
                        details["markers"] = {name: bool(re.search(pattern, text)) for name, pattern in {
                            "cloudflare": r"cloudflare|cf-ray", "captcha": r"captcha|turnstile|challenge-platform",
                            "oauth": r"oauth", "invalidSignature": r"invalid.?signature|signature.?mismatch",
                            "accessDenied": r"access.?denied|permission.?denied"}.items()}
                    except Exception:
                        details["markersUnavailable"] = True
                document_responses.append(details)
        context.on("response", record_document_response)
        page = context.pages[0] if context.pages else context.new_page()
        sessions.current_course = re.match(r"^/courses/(\d+)", urls[0].path).group(1)
        sessions.current_page = args.course_url[0]
        runtime_stage = "navigate_authorized_launch"
        page.goto(launch_url or args.course_url[0], wait_until="domcontentloaded")
        base = "https://" + host
        deadline = time.monotonic() + args.login_timeout
        status = None
        runtime_stage = "wait_authorization"
        while time.monotonic() < deadline:
            if args.launch_url_stdin:
                last_document = document_responses[-1] if document_responses else None
                rejected = last_document if last_document and last_document["httpStatus"] in (401, 403) else None
                if rejected:
                    if args.interactive_server:
                        markers = rejected.get("markers", {})
                        state = "waiting_browser_verification" if markers.get("cloudflare") else "waiting_server_authorization"
                        if status != state:
                            print(json.dumps({"state": state, **rejected}), flush=True)
                            status = state
                        page.wait_for_timeout(1000)
                        continue
                    # One bounded normal JavaScript wait, with no fresh grant,
                    # stealth, challenge solving or alternate proxy.
                    settle_deadline = time.monotonic() + 10
                    while time.monotonic() < settle_deadline and document_responses[-1]["httpStatus"] in (401, 403):
                        page.wait_for_timeout(1000)
                    if document_responses[-1]["httpStatus"] not in (401, 403):
                        continue
                    rejected = document_responses[-1]
                    markers = rejected.get("markers", {})
                    state = "needs_browser_verification" if markers.get("cloudflare") and markers.get("captcha") else "server_launch_rejected"
                    print(json.dumps({"state": state, **rejected}), flush=True)
                    atomic_json(path, {**manifest, "scan": {"state": state, "complete": False, **rejected}})
                    context.close()
                    return 2
                if any(media_host(urlparse(frame.url).hostname or "", sessions.extra_hosts) for frame in page.frames):
                    print(json.dumps({"state": "tool_launched", "documentResponses": document_responses}), flush=True)
                    page.wait_for_timeout(args.settle_ms)
                    break
                if any("duo" in frame.url.lower() or "login" in urlparse(frame.url).path.lower() for frame in page.frames) and not args.interactive_server:
                    print(json.dumps({"state": "needs_reauth", "interactiveAuthorizationRequired": True}), flush=True)
                    context.close()
                    return 2
                page.wait_for_timeout(1000)
                continue
            state = "waiting_duo" if any("duo" in frame.url.lower() for frame in page.frames) else "waiting_login"
            try:
                check = context.request.get(base + "/api/v1/courses/" + sessions.current_course, timeout=10000)
                if check.ok and "json" in check.headers.get("content-type", "") and str(response_json(check).get("id")) == sessions.current_course:
                    state = "authorized"
            except Exception:
                pass
            if state != status:
                print(json.dumps({"state": state}), flush=True)
                status = state
            if state == "authorized":
                break
            page.wait_for_timeout(2000)
        else:
            if args.launch_url_stdin:
                state = "needs_browser_verification" if status == "waiting_browser_verification" else "needs_reauth"
                print(json.dumps({"state": state, "verificationTimeoutSeconds": args.login_timeout}), flush=True)
                atomic_json(path, {**manifest, "scan": {"state": state, "complete": False}})
            context.close()
            raise ReauthRequired()
        courses = list(dict.fromkeys(re.match(r"^/courses/(\d+)", value.path).group(1) for value in urls))
        manifest["scan"] = {"startedAt": int(time.time()), "complete": False, "state": "running"}
        atomic_json(path, manifest)
        try:
            if args.all_courses:
                courses = [str(course["id"]) for course in canvas_pages(context, base, "/api/v1/courses?enrollment_type=student&per_page=100", args.max_pages)]
            complete = True
            runtime_stage = "scan_gallery"
            for course in courses:
                sessions.current_course = course
                targets = [] if args.target_only else course_targets(context, base, course, args.max_pages)
                targets.extend(value for value in args.course_url if re.match(r"https://[^/]+/courses/" + course + r"(?:/|$)", value))
                for target in dict.fromkeys(targets):
                    # Only navigate Canvas's own course pages; an LTI iframe is
                    # inspected after Canvas performs its signed launch.
                    if urlparse(target).netloc != host or not urlparse(target).path.startswith("/courses/" + course + "/") and target != base + "/courses/" + course:
                        continue
                    complete = inspect_target(page, target, sessions, args.max_pages, args.settle_ms, navigate=not args.launch_url_stdin) and complete
            # Related streams may never appear as separate gallery cards.
            # Enumerate explicit observed course channels with total-count gates.
            manifest["observedEntryIds"] = list(sessions.entries)
            if args.channel_id:
                if len(courses) != 1:
                    raise RuntimeError("explicit_channel_requires_single_course")
                sessions.channels = {courses[0]: {args.channel_id}}
            verified_scope = set()
            runtime_stage = "query_channel_membership"
            current_channel_keys = set()
            for course, categories in list(sessions.channels.items()):
                candidate = next((sessions.usable(item) for item in sessions.entries.values() if item["courseId"] == course), None)
                for category in categories:
                    current_channel_keys.add(f"{course}:{category}")
                    try:
                        if not candidate:
                            raise ReauthRequired()
                        sessions.current_course = course
                        sessions.current_page = candidate["sourceUrl"]
                        candidates = [candidate]
                        if args.probe:
                            candidates = [{**candidate, "origin": origin_key.split(":https://", 1)[-1], "ks": token}
                                          for origin_key, token in sessions.session_by_origin.items() if origin_key.startswith(course + ":https://")]
                            for item in candidates:
                                item["origin"] = "https://" + item["origin"]
                        found = None
                        for probe_candidate in candidates:
                            try:
                                entries, total = channel_entries(context, probe_candidate, category, args.max_pages)
                                found = (entries, total, probe_candidate)
                                if args.probe:
                                    print(json.dumps({"state": "channel_probe", "courseId": course, "categoryId": category,
                                                      "originHost": urlparse(probe_candidate["origin"]).hostname, "result": "verified",
                                                      "totalCount": total, "ksSource": sessions.session_sources.get(course + ":" + probe_candidate["origin"], "entry_literal")}), flush=True)
                                break
                            except Exception as error:
                                if args.probe:
                                    details = error.details if isinstance(error, MediaAPIError) else {"code": "NO_APPLICABLE_SESSION" if isinstance(error, ReauthRequired) else "INVALID_API_RESULT"}
                                    print(json.dumps({"state": "channel_probe", "courseId": course, "categoryId": category,
                                                      "originHost": urlparse(probe_candidate["origin"]).hostname, "result": "unavailable",
                                                      "ksSource": sessions.session_sources.get(course + ":" + probe_candidate["origin"], "entry_literal"), **details}), flush=True)
                                else:
                                    raise
                        if found is None:
                            raise RuntimeError("no_usable_channel_api_session")
                        entries, total, candidate = found
                        for entry in entries:
                            key = f"{course}:{entry}"
                            verified_scope.add(key)
                            sessions.entries[key] = {**candidate, **sessions.entries.get(key, {}), "entryId": entry,
                                                     "channelId": category, "courseId": course}
                        manifest.setdefault("channels", {})[f"{course}:{category}"] = {
                            "state": "verified", "totalCount": total, "uniqueEntries": len(entries),
                            "method": "categoryentry.list.categoryIdEqual"}
                    except Exception as error:
                        complete = False
                        details = error.details if isinstance(error, MediaAPIError) else {"code": "NO_APPLICABLE_SESSION" if isinstance(error, ReauthRequired) else "INVALID_API_RESULT"}
                        manifest.setdefault("channels", {})[f"{course}:{category}"] = {"state": "unavailable", **details}
            if args.probe:
                manifest["scan"].update({"state": "probe_complete", "complete": False, "coverageVerified": False})
                atomic_json(path, manifest)
                print(json.dumps({"state": "probe_complete", "observedEntryIds": list(sessions.entries),
                                  "observedSessionHosts": [key.split(":https://", 1)[-1] for key in sessions.session_by_origin],
                                  "verifiedChannelEntries": len(verified_scope)}, ensure_ascii=False), flush=True)
                return 0 if verified_scope else 2
            # Related streams may never appear as separate gallery cards.
            # Enumerate them before archiving and retain an explicit relation.
            parent_scope = set(verified_scope)
            runtime_stage = "query_child_streams"
            for key in list(parent_scope):
                observed = sessions.entries[key]
                session = sessions.usable(observed)
                sessions.current_course = session["courseId"]
                sessions.current_page = session["sourceUrl"]
                try:
                    children = child_streams(context, session, args.max_pages)
                    for child in children:
                        child_key = f"{child['courseId']}:{child['entryId']}"
                        sessions.entries[child_key] = child
                        verified_scope.add(child_key)
                    manifest.setdefault("streams", {})[f"{session['courseId']}:{session['entryId']}"] = {
                        "state": "verified", "childEntryIds": [child["entryId"] for child in children],
                        "method": "baseentry.list.parentEntryIdEqual"}
                except Exception:
                    complete = False
                    manifest.setdefault("streams", {})[f"{session['courseId']}:{session['entryId']}"] = {"state": "unavailable"}
            discovery_complete = complete
            complete = bool(verified_scope and current_channel_keys and parent_scope and
                all(manifest.get("channels", {}).get(key, {}).get("state") == "verified" for key in current_channel_keys) and
                all(manifest.get("streams", {}).get(key, {}).get("state") == "verified" for key in parent_scope))
            processed = 0
            download_plans = []
            if not verified_scope:
                complete = False
            for key in sorted(verified_scope):
                runtime_stage = "query_entry_metadata"
                observed = sessions.entries[key]
                session = sessions.usable(observed)
                sessions.current_course = session["courseId"]
                sessions.current_page = session["sourceUrl"]
                previous = manifest["entries"].get(key, {})
                try:
                    include_captions = args.with_captions or args.subtitles_only
                    public, private = inventory_entry(context, session, include_captions)
                    if not include_captions:
                        public["captions"] = previous.get("captions", [])
                    public["history"] = previous.get("history", [])
                    if previous.get("files") and (public["updatedAt"] != previous.get("updatedAt") or public["captions"] != previous.get("captions")):
                        public["history"].append({key: previous.get(key) for key in ("updatedAt", "captions", "files", "archivedAt")})
                    public["files"] = previous.get("files", [])
                    unchanged = public["updatedAt"] == previous.get("updatedAt") and public["captions"] == previous.get("captions")
                    has_video = any(item.get("kind") == "video" for item in public["files"])
                    if args.pause_after_inventory:
                        download_plans.append((key, session, public, private))
                    if args.download and not args.pause_after_inventory and (not args.limit or processed < args.limit):
                        if unchanged and previous.get("state") in ("archived", "subtitles_archived") and verified_files(root, previous) and (args.subtitles_only or has_video):
                            public["state"] = "archived"
                        else:
                            public["state"] = "downloading"
                            manifest["entries"][key] = public
                            atomic_json(path, manifest)
                            public["files"] = archive_entry(context, session, public, private, root, args.subtitles_only, include_captions)
                            public["state"] = "archived" if not args.subtitles_only else "subtitles_archived"
                            public["archivedAt"] = int(time.time())
                        processed += 1
                    elif unchanged and previous.get("state") in ("archived", "subtitles_archived") and verified_files(root, previous):
                        public["state"] = previous.get("state", "discovered")
                    manifest["entries"][key] = public
                    atomic_json(path, manifest)
                except ReauthRequired:
                    manifest["entries"][key] = {**previous, "entryId": session["entryId"], "courseId": session["courseId"], "state": "needs_reauth"}
                    complete = False
                    atomic_json(path, manifest)
                except Exception as error:
                    state = "needs_reauth" if re.search(r"\b(?:401|403)\b|expired.session", str(error), re.I) else "retryable_failure"
                    safe_reason = str(error) if str(error) in {"media_identity_mismatch", "flavor_identity_mismatch", "caption_identity_mismatch",
                                                               "media_api_unavailable", "media_api_rejected", "no_authorized_download_format"} else state
                    manifest["entries"][key] = {**previous, "entryId": session["entryId"], "courseId": session["courseId"], "state": state, "failureReason": safe_reason}
                    complete = False
                    atomic_json(path, manifest)
            manifest["scan"] = {"startedAt": manifest["scan"]["startedAt"], "completedAt": int(time.time()),
                                "complete": complete, "state": "complete" if complete else "incomplete",
                                "discoveredEntries": len(sessions.entries), "verifiedScopeEntries": len(verified_scope), "courses": courses,
                                "scope": "supplied_pages" if args.target_only else "visible_course_pages",
                                "coverageVerified": False, "discoveryComplete": discovery_complete}
            scoped_channels = [manifest["channels"][key] for key in current_channel_keys]
            scoped_streams = [manifest["streams"][key] for key in parent_scope]
            manifest["scan"]["scopeComplete"] = bool(complete and scoped_channels and scoped_streams and
                all(value.get("state") == "verified" for value in scoped_channels + scoped_streams))
            # Generic UI pagination is not proof that a KAF gallery is exhaustive.
            # Therefore absent entries are never deleted or automatically marked
            # missing until a platform-specific total-count check is verified.
            atomic_json(path, manifest)
            estimated = sum(max([fmt.get("filesize_approx", 0) for fmt in record.get("formats", [])] or [0]) for record in manifest["entries"].values())
            if args.pause_after_inventory:
                print(json.dumps({"state": "inventory_ready", "entries": len(download_plans), "estimatedMaximumBytes": estimated,
                                  "freeLocalBytes": shutil.disk_usage(root).free, "manifest": str(path)}, ensure_ascii=False), flush=True)
                if not manifest["scan"]["scopeComplete"] or not download_plans:
                    print("Inventory scope is not fully verified; no video download started.", file=sys.stderr)
                    return 2
                input("Review the saved inventory; press Enter to continue downloads in this same login, or Ctrl+C to stop. ")
                for index, (key, session, public, private) in enumerate(download_plans):
                    if args.limit and index >= args.limit:
                        break
                    record = manifest["entries"][key]
                    if record.get("state") == "archived" and verified_files(root, record):
                        continue
                    record["state"] = "downloading"
                    atomic_json(path, manifest)
                    try:
                        record["files"] = archive_entry(context, session, public, private, root, args.subtitles_only, args.with_captions or args.subtitles_only)
                        record["state"] = "subtitles_archived" if args.subtitles_only else "archived"
                        record["archivedAt"] = int(time.time())
                    except Exception as error:
                        record["state"] = "needs_reauth" if isinstance(error, ReauthRequired) or re.search(r"\b(?:401|403)\b", str(error)) else "retryable_failure"
                        record["failureReason"] = "insufficient_local_storage" if str(error) == "insufficient_local_storage" else record["state"]
                        complete = False
                    atomic_json(path, manifest)
            if args.download:
                counts = {state: sum(manifest["entries"].get(key, {}).get("state") == state for key in verified_scope)
                          for state in ("archived", "subtitles_archived", "needs_reauth", "retryable_failure", "downloading", "discovered")}
                manifest["archive"] = {"completedAt": int(time.time()), "scopeEntries": len(verified_scope),
                                       "counts": counts, "state": "complete" if counts["archived"] + counts["subtitles_archived"] == len(verified_scope) and verified_scope else "incomplete"}
                atomic_json(path, manifest)
            print(json.dumps({"entries": len(sessions.entries), "scanComplete": manifest["scan"]["complete"],
                              "scopeComplete": manifest["scan"]["scopeComplete"], "archive": manifest.get("archive"),
                              "estimatedMaximumBytes": estimated, "freeLocalBytes": shutil.disk_usage(root).free,
                              "manifest": str(path)}, ensure_ascii=False))
            return 0 if complete else 2
        except ReauthRequired:
            manifest["scan"]["state"] = "needs_reauth"
            atomic_json(path, manifest)
            print("Login expired; progress saved. Log in again and rerun.", file=sys.stderr)
            return 2
        except Exception:
            manifest["scan"]["state"] = "retryable_failure"
            atomic_json(path, manifest)
            print("Inventory incomplete; progress saved. No archived files removed.", file=sys.stderr)
            return 2
        finally:
            context.close()
            if browser:
                browser.close()


if __name__ == "__main__":
    # Never print exception details: third-party errors may contain signed URLs.
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as error:
        print(json.dumps(safe_runtime_failure(error)), file=sys.stderr, flush=True)
        sys.exit(2)
