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
from urllib.parse import parse_qs, quote, unquote, urlparse, urlunparse

runtime_stage = "arguments"


def safe_runtime_failure(error):
    message = str(error).lower()
    patterns = {"READ_ONLY_RUNTIME": r"read-only file system", "RUNTIME_PERMISSION": r"permission denied|eacces",
                "DISPLAY_UNAVAILABLE": r"missing x server|\$display|cannot open display",
                "BROWSER_NOT_INSTALLED": r"executable doesn't exist", "CRASHPAD_RUNTIME": r"crashpad",
                "BROWSER_SANDBOX": r"no usable sandbox|without --no-sandbox", "TIMEOUT": r"timeout"}
    code = next((key for key, pattern in patterns.items() if re.search(pattern, message)), "RUNTIME_FAILURE")
    return {"state": "runtime_failure", "stage": runtime_stage, "exceptionType": type(error).__name__, "code": code}


def script_error_category(message):
    patterns = {"CSP_REJECTED": r"content.security.policy|refused to.*script", "CORS_REJECTED": r"cors|access.control.allow.origin",
                "POSTMESSAGE_ORIGIN": r"postmessage|target origin", "FAILED_SCRIPT_LOAD": r"loading chunk|failed to.*module|script.*load|unexpected token.*<",
                "UNDEFINED_RUNTIME_OBJECT": r"is not defined|referenceerror", "JAVASCRIPT_TYPE_ERROR": r"typeerror|cannot read prop"}
    return next((key for key, pattern in patterns.items() if re.search(pattern, str(message), re.I)), "JAVASCRIPT_ERROR")


def safe_request_location(url):
    parsed = urlparse(public_url(url))
    path = parsed.path
    if (parsed.hostname or "").endswith(".cloudflare.com") and path.startswith("/cdn-cgi/challenge-platform/"):
        path = "/cdn-cgi/challenge-platform/[redacted]"
    return {"host": parsed.hostname, "path": path}


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
        self.channel_evidence: list[dict] = []
        self.api_origins: set[str] = set()
        self.gallery_members: dict[str, set[str]] = {}
        self.gallery_totals: dict[str, int] = {}
        self.gallery_diagnostics: list[dict] = []

    def remember_channel(self, url: str):
        parsed = urlparse(url)
        if not media_host(parsed.hostname or "", self.extra_hosts):
            return
        category = re.search(r"/channel/channelid/(\d+)(?:/|$)", parsed.path)
        direct_gallery = bool(category)
        if not category and self.current_course.isdigit():
            category = re.search(r"^/channel/" + re.escape(self.current_course) + r"/(\d+)(?:/|$)", parsed.path)
            direct_gallery = bool(category)
        if not category:
            category = re.search(r"/(?:categoryid|categoryId)/(\d+)(?:/|$)", parsed.path)
        if not category:
            category = re.search(r"/media/(?:[^/]+/)*[01]_[A-Za-z0-9]+/(\d+)(?:/|$)", parsed.path)
        if category:
            self.channels.setdefault(self.current_course, set()).add(category.group(1))
            item = {"courseId": self.current_course, "channelId": category.group(1), "observedUrl": public_url(url),
                    "method": "observed_channel_url" if direct_gallery else "observed_media_category_url"}
            if item not in self.channel_evidence and len(self.channel_evidence) < 2000:
                self.channel_evidence.append(item)

    def observe_request(self, request):
        parsed = urlparse(request.url)
        if parsed.scheme != "https" or not media_host(parsed.hostname or "", self.extra_hosts):
            return
        self.remember_channel(request.url)
        origin = f"https://{parsed.netloc}"
        is_api = parsed.path.lower().startswith("/api_v3/") and not re.search(r"(?:^|\.)(?:analytics|stats)(?:\.|$)", parsed.hostname or "", re.I)
        if is_api:
            self.api_origins.add(origin)
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
                        self.remember(value, origin, session, is_api)

    def remember(self, entry: str, origin: str, session: str | None, api_observed: bool = False):
        key = f"{self.current_course}:{entry}"
        old = self.entries.get(key, {})
        if old.get("apiObserved") and not api_observed:
            return  # Analytics/manifest observations must not replace an API KS.
        self.entries[key] = {**old, "entryId": entry, "courseId": self.current_course,
                             "origin": origin, "ks": session or old.get("ks"),
                             "sourceUrl": public_url(self.current_page), "apiObserved": api_observed}

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
        is_api = parsed.path.lower().startswith("/api_v3/") and not re.search(r"(?:^|\.)(?:analytics|stats)(?:\.|$)", parsed.hostname or "", re.I)
        if is_api:
            self.api_origins.add(origin)
        for item in fields(data):
            # Response-issued KS covers bootstrap/multirequest session start.
            if isinstance(item.get("ks"), str):
                self.session_by_origin[f"{self.current_course}:{origin}"] = item["ks"]
                self.session_sources[f"{self.current_course}:{origin}"] = "observed_response_session"
            if item.get("objectType") in ("KalturaMediaEntry", "KalturaBaseEntry") and re.fullmatch(r"[01]_[A-Za-z0-9]+", str(item.get("id", ""))):
                self.remember(item["id"], origin, self.session_by_origin.get(f"{self.current_course}:{origin}"), is_api)

    def usable(self, value: dict) -> dict:
        result = {**value, "ks": value.get("ks") or self.session_by_origin.get(f"{value['courseId']}:{value['origin']}")}
        if result["origin"] not in self.api_origins and len(self.api_origins) == 1:
            result["origin"] = next(iter(self.api_origins))
        result["_allowedMediaHosts"] = sorted(self.extra_hosts)
        return result


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
    data_url = urlparse(str(info.get("dataUrl", "")))
    if data_url.scheme != "https" or data_url.username or data_url.password or not media_host(data_url.hostname or "", set(session.get("_allowedMediaHosts", []))):
        raise MediaAPIError("UNTRUSTED_MEDIA_URL", 200, session["origin"], "baseentry", "get")
    encoded_session = quote(session["ks"], safe="")
    for flavor in flavors:
        if flavor.get("status") != 2 or flavor.get("fileExt") in ("wvm", "chun"):
            continue
        if not re.fullmatch(r"[01]_[A-Za-z0-9]+", str(flavor.get("id", ""))):
            raise RuntimeError("flavor_identity_mismatch")
        formats.append({"format_id": str(flavor["id"]), "ext": flavor.get("fileExt") or "mp4",
                        "height": flavor.get("height"), "width": flavor.get("width"),
                        "tbr": flavor.get("bitrate"), "filesize_approx": int(flavor.get("size") or 0) * 1024,
                        "preference": 10 if flavor.get("isOriginal") else 0,
                        "url": urlunparse(data_url._replace(path=data_url.path.rstrip("/") + "/flavorId/" + flavor["id"] + "/ks/" + encoded_session))})
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
              "mediaAssets": sorted([{"id": item["id"], "version": item.get("version"), "updatedAt": item.get("updatedAt"),
                                      "size": item.get("size")} for item in flavors if str(item.get("id")) in {value["format_id"] for value in formats}],
                                    key=lambda item: item["id"]),
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


def archive_entry(context, session: dict, metadata: dict, private: dict, root: Path, subtitles_only: bool, include_captions: bool = False, reserve_bytes: int = 15 * 1024**3) -> list[dict]:
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
        if shutil.disk_usage(root).free < maximum + reserve_bytes:
            raise RuntimeError("insufficient_local_storage")
        # A checksum failure must not be "repaired" by yt-dlp skipping the
        # existing final file. Retain its bytes under a corruption name, then
        # allow a fresh final file or an existing .part to be downloaded.
        for prior in metadata.get("files", []):
            damaged = (root / prior["path"]).resolve()
            if prior.get("kind") == "video" and damaged.is_relative_to(directory.resolve()) and damaged.is_file():
                actual_hash = sha256(damaged)
                if actual_hash != prior.get("sha256"):
                    damaged.rename(damaged.with_name("corrupt-" + actual_hash + "-" + damaged.name))
        import yt_dlp
        last_storage_check = 0
        def guard_storage(progress):
            nonlocal last_storage_check
            if progress.get("status") == "downloading" and time.monotonic() - last_storage_check > 2:
                last_storage_check = time.monotonic()
                if shutil.disk_usage(root).free < reserve_bytes:
                    raise RuntimeError("insufficient_local_storage")
        # yt-dlp's public Kaltura extractor starts a widget KS itself. Supplying
        # already-authorized formats avoids replacing the browser's scoped KS.
        with yt_dlp.YoutubeDL({"logger": QuietLogger(), "quiet": True, "no_warnings": True,
                              "outtmpl": str(directory / ("original.%(ext)s" if metadata.get("selectedVideoFormat", {}).get("isOriginalSource", True) else
                                                         "video-" + str(metadata["selectedVideoFormat"]["formatId"]) + ".%(ext)s")), "continuedl": True,
                              "retries": 3, "fragment_retries": 3, "concurrent_fragment_downloads": 1,
                              "writeinfojson": False, "noprogress": True, "progress_hooks": [guard_storage]}) as downloader:
            result = downloader.process_ie_result({"id": session["entryId"], "title": metadata["title"],
                                                    "formats": private["formats"]}, download=True)
            filename = Path(result.get("filepath") or downloader.prepare_filename(result))
        if not filename.is_file() or filename.stat().st_size == 0:
            raise RuntimeError("video_download_incomplete")
        files.append({"kind": "video", "path": str(filename.relative_to(root)), "sha256": sha256(filename), "bytes": filename.stat().st_size,
                      "selectedFormat": metadata.get("selectedVideoFormat")})
    return files


def plan_video_formats(plans, budget: int, policy: str) -> dict:
    selected = {}
    pending = [(key, public, private) for key, _session, public, private in plans if public.get("state") != "archived"]
    for key, public, private in pending:
        formats = private["formats"]
        if not formats:
            raise RuntimeError("no_authorized_download_format")
        if policy == "original" and not any(item.get("preference", 0) == 10 for item in formats):
            raise RuntimeError("no_authorized_original_format")
        selected[key] = max(formats, key=lambda item: (item.get("preference", 0), item.get("height") or 0, item.get("tbr") or 0))
    original_total = sum(item.get("filesize_approx", 0) for item in selected.values())
    used_policy = "original"
    if policy == "hd" or policy == "auto" and original_total > budget:
        used_policy = "hd"
        for key, public, private in pending:
            hd = [item for item in private["formats"] if (item.get("height") or 0) >= 720 and item.get("filesize_approx", 0) > 0]
            if not hd:
                raise RuntimeError("no_authorized_hd_format")
            best_height = max(item["height"] for item in hd)
            selected[key] = min((item for item in hd if item["height"] == best_height), key=lambda item: item["filesize_approx"])
        # Prefer 1080p; only choose an available 720p source if needed to fit.
        while sum(item.get("filesize_approx", 0) for item in selected.values()) > budget:
            alternatives = []
            for key, _public, private in pending:
                cheaper = [item for item in private["formats"] if (item.get("height") or 0) >= 720 and item.get("filesize_approx", 0) > 0
                           and item["filesize_approx"] < selected[key]["filesize_approx"]]
                if cheaper:
                    choice = min(cheaper, key=lambda item: item["filesize_approx"])
                    alternatives.append((selected[key]["filesize_approx"] - choice["filesize_approx"], key, choice))
            if not alternatives:
                break
            _saving, key, choice = max(alternatives, key=lambda item: item[0])
            selected[key] = choice
    total = sum(item.get("filesize_approx", 0) for item in selected.values())
    result = {"policy": used_policy, "originalEstimatedBytes": original_total, "selectedEstimatedBytes": total,
              "budgetBytes": max(budget, 0), "missingCapacityBytes": max(total - budget, 0),
              "unknownSizeEntries": sum(not item.get("filesize_approx") for item in selected.values()),
              "selections": {key: {field: item.get(field) for field in ("format_id", "height", "width", "filesize_approx", "preference")}
                             for key, item in selected.items()}}
    if total > budget:
        print(json.dumps({"state": "archive_capacity_blocked", **{key: value for key, value in result.items() if key != "selections"}}), flush=True)
        return result
    for key, public, private in pending:
        item = selected[key]
        asset = next((value for value in public.get("mediaAssets", []) if value["id"] == item["format_id"]), {})
        public["selectedVideoFormat"] = {"formatId": item["format_id"], "height": item.get("height"), "width": item.get("width"),
                                        "bitrate": item.get("tbr"), "sourceVersion": asset.get("version"), "sourceUpdatedAt": asset.get("updatedAt"),
                                        "isOriginalSource": item.get("preference", 0) == 10, "policy": used_policy}
        private["formats"] = [item]
    return result


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
    for tool in canvas_pages(context, base, f"/api/v1/courses/{course}/external_tools?include_parents=true&placement=course_navigation&per_page=100", max_pages):
        name = str(tool.get("name", ""))
        if not re.search(r"\bmy\s*media\b", name, re.I) and re.search(r"kaltura|media gallery|course media|recording", name, re.I):
            targets.append(f"{base}/courses/{course}/external_tools/{tool['id']}")
    return list(dict.fromkeys(targets))


def inspect_target(page, url: str, sessions: Sessions, max_pages: int, settle_ms: int, navigate: bool = True, gallery_url: str | None = None, channel_id: str | None = None, entry_id: str | None = None) -> bool:
    sessions.current_page = url
    if navigate:
        page.goto(url, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(settle_ms)
    if "/login" in page.url:
        raise ReauthRequired()
    visited = set()
    pagination_attempts = set()
    for _ in range(max_pages):
        more = False
        for frame in list(page.frames):
            try:
                frame_url = urlparse(frame.url)
                if not media_host(frame_url.hostname or "", sessions.extra_hosts):
                    continue
                sessions.remember_channel(frame.url)
                if gallery_url and public_url(frame.url) == gallery_url and channel_id:
                    summary = frame.evaluate("""() => {
                      const totalLabels = [...document.body.innerText.matchAll(/\\b(\\d+)\\s+Media\\b/gi)].map(m => ({value:Number(m[1]),label:m[0]}));
                      const anchors = [...document.querySelectorAll('a[href*="/media/"]')].filter(n => n.getBoundingClientRect().width > 0)
                        .map(n => ({path:new URL(n.href).pathname,text:n.innerText.trim().slice(0,100),
                          parents:[n.parentElement,n.parentElement?.parentElement].filter(Boolean).map(p => ({tag:p.tagName,id:p.id,className:String(p.className)}))}));
                      const next = [...document.querySelectorAll('a[rel="next"],button[aria-label="Next"],a[aria-label="Next"],.pagination-next a')].filter(n => n.getBoundingClientRect().width>0)
                        .map(n => ({text:n.innerText.trim().slice(0,40),disabled:n.disabled||n.getAttribute('aria-disabled')==='true'}));
                      const paginationControls = [...document.querySelectorAll('a,button,[role="button"]')]
                        .filter(n => n.getBoundingClientRect().width>0 && /load\\s+more|show\\s+more|next/i.test(n.innerText+' '+n.getAttribute('aria-label')))
                        .map(n => ({tag:n.tagName,id:n.id,className:String(n.className),text:n.innerText.trim().slice(0,80),ariaLabel:n.getAttribute('aria-label'),
                          path:n.href ? new URL(n.href).pathname : null,disabled:n.disabled||n.getAttribute('aria-disabled')==='true'}));
                      return {totalLabels,anchors,next,paginationControls};
                    }""")
                    members = set()
                    card_details = []
                    for anchor in summary["anchors"]:
                        match = re.search(r"/media/(?:[^/]+/)*([01]_[A-Za-z0-9]+)/(?:categoryid/)?" + re.escape(channel_id) + r"(?:/|$)", anchor["path"])
                        if match:
                            members.add(match[1])
                            card_details.append({"entryId": match[1], "title": anchor["text"], "parents": anchor["parents"]})
                    key = f"{sessions.current_course}:{channel_id}"
                    sessions.gallery_members.setdefault(key, set()).update(members)
                    totals = {label["value"] for label in summary["totalLabels"]}
                    if len(totals) == 1:
                        total = next(iter(totals))
                        if key in sessions.gallery_totals and sessions.gallery_totals[key] != total:
                            return False
                        sessions.gallery_totals[key] = total
                    sessions.gallery_diagnostics.append({"courseId": sessions.current_course, "channelId": channel_id,
                                                         "totalLabels": summary["totalLabels"], "cardEntries": card_details,
                                                         "nextControls": summary["next"], "paginationControls": summary["paginationControls"]})
                    print(json.dumps({"state": "native_gallery_page", "courseId": sessions.current_course, "channelId": channel_id,
                                      "totalLabels": summary["totalLabels"], "uniqueCardEntries": len(members),
                                      "paginationControls": summary["paginationControls"]}), flush=True)
                # Load per-entry pages to obtain an applicable session/context.
                anchors = frame.locator('a[href*="/entryid/"], a[href*="/entry_id/"], a[href*="/media/"]').evaluate_all("nodes => nodes.map(n => n.href)")
                for href in anchors:
                    sessions.remember_channel(href)
                    target = urlparse(href)
                    media_entry = re.search(r"/([01]_[A-Za-z0-9]+)(?:/|$)", target.path)
                    visit_key = media_entry[1] if media_entry else public_url(href)
                    if target.scheme != "https" or not media_host(target.hostname or "", sessions.extra_hosts) or visit_key in visited:
                        continue
                    if entry_id and not re.search(r"(?:/|=)" + re.escape(entry_id) + r"(?:/|&|$)", href):
                        continue
                    visited.add(visit_key)
                    if media_entry:
                        print(json.dumps({"state": "observe_entry_page", "courseId": sessions.current_course,
                                          "entryId": media_entry[1]}), flush=True)
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
                elif gallery_url and public_url(frame.url) == gallery_url and channel_id:
                    key = f"{sessions.current_course}:{channel_id}"
                    before = set(sessions.gallery_members.get(key, set()))
                    expected = sessions.gallery_totals.get(key)
                    attempt = (key, len(before))
                    if expected is not None and expected > len(before) and attempt not in pagination_attempts:
                        pagination_attempts.add(attempt)
                        print(json.dumps({"state": "native_gallery_scroll", "courseId": sessions.current_course,
                                          "observedMembers": len(before), "expectedMembers": expected}), flush=True)
                        # Ordinary gallery scroll can activate its own lazy
                        # pagination. No synthetic API route or request fields.
                        frame.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)")
                        page.wait_for_timeout(settle_ms)
                        after_urls = frame.locator('a[href*="/media/"]').evaluate_all("nodes => nodes.map(n => new URL(n.href).pathname)")
                        after = {match[1] for path in after_urls if (match := re.search(r"/media/(?:[^/]+/)*([01]_[A-Za-z0-9]+)/(?:categoryid/)?" + re.escape(channel_id) + r"(?:/|$)", path))}
                        more = bool(after - before)
                        print(json.dumps({"state": "native_gallery_scroll_result", "courseId": sessions.current_course,
                                          "newCardMembers": len(after - before)}), flush=True)
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
    parser.add_argument("--inventory-first", action="store_true", help="Validate all authorized entries and budget formats before starting downloads")
    parser.add_argument("--video-policy", choices=("auto", "original", "hd"), default="original")
    parser.add_argument("--reserve-gib", type=int, default=15, help="Free space reserved for website, PDF and backup temporary data")
    parser.add_argument("--target-only", action="store_true", help="Visit only supplied pages for a first authorized sample")
    parser.add_argument("--channel-id", help="Explicit observed Kaltura channel for a single-course acceptance scope")
    parser.add_argument("--entry-id", help="One explicitly observed entry for a partial authorized metadata/download trial; does not assert full channel coverage")
    parser.add_argument("--known-gallery-url", help="One already-observed KAF channel URL to navigate in the authorized context; no URL guessing")
    parser.add_argument("--verify-observed-asset-url", help="One explicitly observed public Kaltura script URL for normal manual CDN verification before returning to the known gallery")
    parser.add_argument("--probe", action="store_true", help="Read-only scoped API origin/permission diagnosis; never downloads")
    parser.add_argument("--discover-channels", action="store_true", help="Only read actually visible frame/link channel URLs; no guessed gallery, metadata API, or downloads")
    parser.add_argument("--hold-browser", type=int, default=0, help="After a read-only probe, hold the same browser for visual diagnosis for up to 900 seconds")
    parser.add_argument("--headless", action="store_true", help="Official Chromium headless shell on the server")
    parser.add_argument("--interactive-server", action="store_true", help="Normal headed Chromium in a temporary server display, with manual verification")
    parser.add_argument("--launch-url-stdin", action="store_true", help="Read a Canvas-authorized sessionless launch JSON from stdin; never log or persist the URL")
    parser.add_argument("--login-timeout", type=int, default=900, help="Seconds allowed for interactive school login and Duo")
    args = parser.parse_args()
    urls = [urlparse(value) for value in args.course_url]
    host = urls[0].netloc
    if any(value.scheme != "https" or value.netloc != host or not re.match(r"^/courses/\d+", value.path) or value.username for value in urls):
        parser.error("Provide HTTPS Canvas course URLs from one instance")
    if args.max_pages < 1 or args.settle_ms < 0 or args.limit < 0 or args.login_timeout < 1 or args.reserve_gib < 15:
        parser.error("Invalid limits")
    if args.pause_after_inventory and not args.download:
        parser.error("--pause-after-inventory requires --download")
    if args.inventory_first and not args.download:
        parser.error("--inventory-first requires --download")
    if args.channel_id and (not args.channel_id.isdigit() or args.all_courses):
        parser.error("--channel-id requires one numeric channel and a single-course run")
    if args.entry_id and (not re.fullmatch(r"[01]_[A-Za-z0-9]+", args.entry_id) or args.all_courses or len(urls) != 1):
        parser.error("--entry-id requires one observed entry and a single-course run")
    if args.known_gallery_url:
        gallery = urlparse(args.known_gallery_url)
        gallery_paths = {"/channel/channelid/" + str(args.channel_id), "/channel/" + re.match(r"^/courses/(\d+)", urls[0].path).group(1) + "/" + str(args.channel_id)}
        if not args.channel_id or gallery.scheme != "https" or not media_host(gallery.hostname or "", {value.lower() for value in args.media_host}) or gallery.path not in gallery_paths or gallery.query or gallery.fragment or gallery.username or gallery.password:
            parser.error("Known gallery must be a previously observed HTTPS channel URL for the explicit channel")
    if args.verify_observed_asset_url:
        asset = urlparse(args.verify_observed_asset_url)
        if not args.interactive_server or not args.known_gallery_url or asset.scheme != "https" or not media_host(asset.hostname or "", {value.lower() for value in args.media_host}) or not asset.path.endswith(".js") or asset.query or asset.fragment or asset.username or asset.password:
            parser.error("Asset verification requires interactive server, a known gallery and one observed public HTTPS script URL without credentials")
    if args.probe and args.download:
        parser.error("--probe cannot download")
    if args.discover_channels and (args.download or args.probe or args.entry_id or args.all_courses or args.known_gallery_url or args.verify_observed_asset_url or len(urls) != 1):
        parser.error("--discover-channels needs one launch only, without download, probe, entry or guessed/known gallery navigation")
    if args.hold_browser < 0 or args.hold_browser > 900 or args.hold_browser and not args.probe:
        parser.error("--hold-browser requires --probe and must be between 0 and 900")
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
        network_failures = []
        script_errors = []
        def record_failed_request(request):
            if request.resource_type == "media":
                return  # Intentionally blocked during discovery.
            if len(network_failures) < 100:
                error_code = re.search(r"ERR_[A-Z_]+", request.failure or "")
                network_failures.append({**safe_request_location(request.url), "resourceType": request.resource_type,
                                         "failureCode": error_code.group(0) if error_code else "NETWORK_FAILURE", "phase": runtime_stage})
        def record_failed_response(response):
            if response.status >= 400 and len(network_failures) < 100:
                network_failures.append({**safe_request_location(response.url), "resourceType": response.request.resource_type,
                                         "httpStatus": response.status, "phase": runtime_stage})
        def attach_page_diagnostics(diagnostic_page):
            def page_error(error):
                if len(script_errors) < 50:
                    line = re.search(r":(\d+):(\d+)(?:\)?\s*$)", getattr(error, "stack", ""), re.M)
                    script_errors.append({"category": script_error_category(error), "line": int(line[1]) if line else None,
                                          "column": int(line[2]) if line else None, "phase": runtime_stage})
            def console_error(message):
                if message.type == "error" and len(script_errors) < 50:
                    location = message.location
                    script_errors.append({"category": script_error_category(message.text),
                                          "line": location.get("lineNumber"), "column": location.get("columnNumber"),
                                          **safe_request_location(location.get("url", "")), "phase": runtime_stage})
            diagnostic_page.on("pageerror", page_error)
            diagnostic_page.on("console", console_error)
        context.on("requestfailed", record_failed_request)
        context.on("response", record_failed_response)
        context.on("page", attach_page_diagnostics)
        for diagnostic_page in context.pages:
            attach_page_diagnostics(diagnostic_page)
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
        if args.discover_channels:
            runtime_stage = "read_observed_channel_links"
            page.wait_for_timeout(args.settle_ms)
            native_totals = []
            for frame in page.frames:
                if not media_host(urlparse(frame.url).hostname or "", sessions.extra_hosts):
                    continue
                sessions.remember_channel(frame.url)
                try:
                    links = frame.locator('a[href]').evaluate_all("nodes => nodes.map(n => n.href)")
                    for link in links:
                        sessions.remember_channel(link)
                    totals = frame.evaluate("() => [...document.body.innerText.matchAll(/\\b(\\d+)\\s+Media\\b/gi)].map(m => ({value:Number(m[1]),label:m[0]}))")
                    native_totals.append({**safe_request_location(frame.url), "totalLabels": totals,
                                          "observedEmpty": bool(totals and {item["value"] for item in totals} == {0})})
                except Exception:
                    pass
            result = {"state": "channel_links_discovered" if sessions.channel_evidence else "channel_links_not_found",
                      "courseId": courses[0], "observedChannels": sessions.channel_evidence,
                      "frames": [safe_request_location(frame.url) for frame in page.frames],
                      "nativeGalleryTotals": native_totals,
                      "complete": False, "downloadRequested": False}
            atomic_json(root / ("channel-discovery-" + courses[0] + ".json"), result)
            print(json.dumps(result, ensure_ascii=False), flush=True)
            context.close()
            if browser:
                browser.close()
            return 0 if sessions.channel_evidence else 2
        if args.verify_observed_asset_url:
            runtime_stage = "wait_observed_asset_browser_verification"
            asset_documents = []
            def record_asset_document(response):
                if response.request.resource_type == "document" and public_url(response.url) == args.verify_observed_asset_url:
                    asset_documents.append({"httpStatus": response.status, "contentType": response.headers.get("content-type", "").split(";", 1)[0].lower()})
            context.on("response", record_asset_document)
            page.goto(args.verify_observed_asset_url, wait_until="domcontentloaded", timeout=60000)
            print(json.dumps({"state": "waiting_asset_browser_verification", **safe_request_location(args.verify_observed_asset_url),
                              "timeoutSeconds": args.login_timeout}), flush=True)
            asset_deadline = time.monotonic() + args.login_timeout
            while time.monotonic() < asset_deadline:
                latest_asset = asset_documents[-1] if asset_documents else None
                if latest_asset and latest_asset["httpStatus"] == 200 and latest_asset["contentType"] and "html" not in latest_asset["contentType"]:
                    print(json.dumps({"state": "observed_asset_verified", **latest_asset}), flush=True)
                    break
                page.wait_for_timeout(1000)
            else:
                print(json.dumps({"state": "needs_asset_browser_verification", "timeoutSeconds": args.login_timeout}), flush=True)
                atomic_json(path, {**manifest, "scan": {"state": "needs_asset_browser_verification", "complete": False}})
                context.close()
                return 2
        if args.known_gallery_url:
            print(json.dumps({"state": "launch_page_before_observed_gallery", "frames": [
                safe_request_location(frame.url) for frame in page.frames],
                "networkFailures": list(network_failures), "scriptErrors": list(script_errors)}, ensure_ascii=False), flush=True)
            runtime_stage = "navigate_observed_gallery"
            page.goto(args.known_gallery_url, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(args.settle_ms)
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
                    complete = inspect_target(page, target, sessions, args.max_pages, args.settle_ms, navigate=not args.launch_url_stdin,
                                              gallery_url=args.known_gallery_url, channel_id=args.channel_id, entry_id=args.entry_id) and complete
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
                                          for origin_key, token in sessions.session_by_origin.items()
                                          if origin_key.startswith(course + ":https://") and "https://" + origin_key.split(":https://", 1)[-1] in sessions.api_origins]
                            for item in candidates:
                                item["origin"] = "https://" + item["origin"]
                        found = None
                        last_api_error = None
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
                                last_api_error = error
                                if args.probe:
                                    details = error.details if isinstance(error, MediaAPIError) else {"code": "NO_APPLICABLE_SESSION" if isinstance(error, ReauthRequired) else "INVALID_API_RESULT"}
                                    print(json.dumps({"state": "channel_probe", "courseId": course, "categoryId": category,
                                                      "originHost": urlparse(probe_candidate["origin"]).hostname, "result": "unavailable",
                                                      "ksSource": sessions.session_sources.get(course + ":" + probe_candidate["origin"], "entry_literal"), **details}), flush=True)
                                else:
                                    raise
                        if found is None:
                            raise last_api_error or RuntimeError("no_usable_channel_api_session")
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
                        details = error.details if isinstance(error, MediaAPIError) else {"code": "NO_APPLICABLE_SESSION" if isinstance(error, ReauthRequired) else "INVALID_API_RESULT"}
                        manifest.setdefault("channels", {})[f"{course}:{category}"] = {"state": "unavailable", **details}
                        key = f"{course}:{category}"
                        native_members = sessions.gallery_members.get(key, set())
                        native_total = sessions.gallery_totals.get(key)
                        if native_total is not None and native_total >= len(native_members):
                            manifest["channels"][key] = {"state": "verified" if native_total == len(native_members) else "partial", "totalCount": native_total,
                                                        "uniqueEntries": len(native_members), "method": "kaf_native_visible_gallery_total",
                                                        "nativeLabel": f"{native_total} Media", "restrictedApi": details,
                                                        "memberEntryIds": sorted(native_members),
                                                        "missingMembershipCount": native_total - len(native_members)}
                            if native_total != len(native_members):
                                complete = False
                            observed_members = {entry for entry in native_members if f"{course}:{entry}" in sessions.entries}
                            verified_scope.update(f"{course}:{entry}" for entry in observed_members)
                            if observed_members != native_members:
                                complete = False
                                manifest["channels"][key]["state"] = "incomplete"
                                manifest["channels"][key]["unobservedEntryIds"] = sorted(native_members - observed_members)
                            for entry in native_members:
                                observed_key = f"{course}:{entry}"
                                if observed_key in sessions.entries:
                                    sessions.entries[observed_key]["channelId"] = category
                        else:
                            complete = False
            if args.probe:
                if args.entry_id:
                    key = f"{courses[0]}:{args.entry_id}"
                    if key not in sessions.entries:
                        raise RuntimeError("requested_entry_not_observed")
                    try:
                        public, _private = inventory_entry(context, sessions.usable(sessions.entries[key]), False)
                        manifest["entries"][key] = public
                        print(json.dumps({"state": "authorized_entry_probe", "entryId": args.entry_id,
                                          "identityVerified": True, "durationSeconds": public["durationSeconds"],
                                          "formatCount": len(public["formats"]), "channelCoverageVerified": False}), flush=True)
                    except Exception as error:
                        details = error.details if isinstance(error, MediaAPIError) else {"code": "ENTRY_IDENTITY_OR_METADATA_FAILED"}
                        print(json.dumps({"state": "authorized_entry_probe", "entryId": args.entry_id,
                                          "identityVerified": False, **details}), flush=True)
                manifest["scan"].update({"state": "probe_complete", "complete": False, "coverageVerified": False})
                atomic_json(path, manifest)
                print(json.dumps({"state": "probe_complete", "observedEntryIds": list(sessions.entries),
                                  "observedSessionHosts": [key.split(":https://", 1)[-1] for key in sessions.session_by_origin],
                                  "verifiedChannelEntries": len(verified_scope)}, ensure_ascii=False), flush=True)
                frames = []
                for diagnostic_frame in page.frames:
                    try:
                        stats = diagnostic_frame.evaluate("() => ({htmlBytes: new TextEncoder().encode(document.documentElement.outerHTML).length, scriptCount: document.scripts.length, iframeCount: document.querySelectorAll('iframe').length, topLevel: window.top === window.self})")
                    except Exception:
                        stats = {"frameInspectionUnavailable": True}
                    frames.append({**safe_request_location(diagnostic_frame.url), **stats})
                print(json.dumps({"state": "page_diagnostics", "networkFailureCount": len(network_failures), "networkFailures": network_failures[:12],
                                  "scriptErrors": script_errors, "frames": frames,
                                  "nativeGallery": sessions.gallery_diagnostics,
                                  "failedStaticAssets": sum(item.get("resourceType") in ("script", "stylesheet", "font") for item in network_failures)}, ensure_ascii=False), flush=True)
                if args.hold_browser:
                    title = page.title()
                    if re.search(r"ks=|oauth_signature|session_token|https?://", title, re.I):
                        title = "[redacted]"
                    frames = [{"host": urlparse(frame.url).hostname,
                               "path": urlparse(public_url(frame.url)).path} for frame in page.frames]
                    print(json.dumps({"state": "browser_held_for_diagnosis", "holdSeconds": args.hold_browser,
                                      "pageTitle": title[:160], "frames": frames}, ensure_ascii=False), flush=True)
                    page.wait_for_timeout(args.hold_browser * 1000)
                return 0 if verified_scope else 2
            # Related streams may never appear as separate gallery cards.
            if sessions.gallery_diagnostics:
                diagnostics = sessions.gallery_diagnostics if args.entry_id else [
                    {"courseId": item["courseId"], "channelId": item["channelId"], "totalLabels": item["totalLabels"],
                     "uniqueCardEntries": len({card["entryId"] for card in item["cardEntries"]}), "nextControls": item["nextControls"]}
                    for item in sessions.gallery_diagnostics]
                print(json.dumps({"state": "native_gallery_inventory", "nativeGallery": diagnostics}, ensure_ascii=False), flush=True)
            if args.entry_id:
                partial_key = f"{courses[0]}:{args.entry_id}"
                if partial_key not in sessions.entries:
                    raise RuntimeError("requested_entry_not_observed")
                verified_scope = {partial_key}
                manifest["partialEntryTrial"] = {"entryId": args.entry_id, "observedInCourseContext": True,
                                               "channelCoverageVerified": False}
            # Enumerate them before archiving and retain an explicit relation.
            parent_scope = set() if args.entry_id else set(verified_scope)
            metadata_cache = {}
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
                except Exception as error:
                    complete = False
                    details = error.details if isinstance(error, MediaAPIError) else {"code": "CHILD_LIST_UNAVAILABLE"}
                    manifest.setdefault("streams", {})[f"{session['courseId']}:{session['entryId']}"] = {
                        "state": "unavailable", "restrictedApi": details, "coverageVerified": False}
            # Viewer permissions may forbid a broad list while the real player
            # already supplies its other streams. Only an exact server-provided
            # parentEntryId can associate those observed candidates; names and
            # equal durations are not identity evidence.
            if not args.entry_id:
                runtime_stage = "verify_observed_child_metadata"
                for child_key, observed_child in list(sessions.entries.items()):
                    if child_key in parent_scope or child_key in verified_scope:
                        continue
                    if not any(key.startswith(observed_child["courseId"] + ":") for key in parent_scope):
                        continue
                    try:
                        child_session = sessions.usable(observed_child)
                        public, private = inventory_entry(context, child_session, args.with_captions or args.subtitles_only)
                        parent_id = public.get("parentEntryId")
                        parent_key = f"{observed_child['courseId']}:{parent_id}"
                        if parent_key not in parent_scope:
                            continue
                        relation = {"method": "baseentry.get.parentEntryId", "parentEntryId": parent_id,
                                    "childEntryId": observed_child["entryId"], "originHost": urlparse(child_session["origin"]).hostname,
                                    "retrievedAt": int(time.time()), "childUpdatedAt": public["updatedAt"]}
                        sessions.entries[child_key] = {**observed_child, "parentEntryId": parent_id, "trackRelation": relation}
                        public["trackRelation"] = relation
                        metadata_cache[child_key] = (public, private)
                        verified_scope.add(child_key)
                        stream = manifest.setdefault("streams", {}).setdefault(parent_key, {"state": "unavailable", "coverageVerified": False})
                        stream.setdefault("observedChildEntryIds", []).append(observed_child["entryId"])
                        stream.setdefault("relationEvidence", []).append(relation)
                        if stream.get("state") == "verified" and observed_child["entryId"] not in stream.get("childEntryIds", []):
                            complete = False
                            stream["state"] = "conflicting_child_coverage"
                            stream["coverageVerified"] = False
                        elif stream.get("state") != "verified":
                            stream["state"] = "observed_relations_verified"
                            stream["coverageVerified"] = False
                        print(json.dumps({"state": "child_relation_verified", "parentEntryId": parent_id,
                                          "childEntryId": observed_child["entryId"], "completeChildCoverage": stream.get("state") == "verified"}), flush=True)
                    except Exception as error:
                        details = error.details if isinstance(error, MediaAPIError) else {"code": "CHILD_IDENTITY_OR_METADATA_FAILED"}
                        print(json.dumps({"state": "observed_child_unverified", "entryId": observed_child["entryId"], **details}), flush=True)
            discovery_complete = complete
            healthy_empty = bool(not args.entry_id and current_channel_keys and
                all(manifest.get("channels", {}).get(key, {}).get("state") == "verified" and
                    manifest["channels"][key].get("totalCount") == 0 for key in current_channel_keys))
            if healthy_empty:
                print(json.dumps({"state": "verified_empty_gallery", "courseIds": courses, "channelCount": len(current_channel_keys)}), flush=True)
            complete = bool(not args.entry_id and current_channel_keys and (parent_scope or healthy_empty) and
                all(manifest.get("channels", {}).get(key, {}).get("state") == "verified" for key in current_channel_keys) and
                all(manifest.get("streams", {}).get(key, {}).get("state") == "verified" for key in parent_scope))
            processed = 0
            download_plans = []
            if not verified_scope and not healthy_empty:
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
                    public, private = metadata_cache.get(key) or inventory_entry(context, session, include_captions)
                    print(json.dumps({"state": "entry_metadata_verified", "entryId": session["entryId"],
                                      "identityVerified": True, "durationSeconds": public["durationSeconds"],
                                      "formatCount": len(public["formats"]), "parentEntryId": public["parentEntryId"],
                                      "track": public["track"]}), flush=True)
                    if not include_captions:
                        public["captions"] = previous.get("captions", [])
                    public["history"] = previous.get("history", [])
                    if previous.get("files") and (public["updatedAt"] != previous.get("updatedAt") or public["captions"] != previous.get("captions")):
                        public["history"].append({key: previous.get(key) for key in ("updatedAt", "captions", "files", "archivedAt")})
                    public["files"] = previous.get("files", [])
                    unchanged = public["updatedAt"] == previous.get("updatedAt") and public["captions"] == previous.get("captions")
                    has_video = any(item.get("kind") == "video" for item in public["files"])
                    old_assets = previous.get("mediaAssets")
                    assets_have_revision = bool(public["mediaAssets"] and all(item["version"] is not None or item["updatedAt"] is not None for item in public["mediaAssets"]))
                    video_assets_unchanged = bool(old_assets and assets_have_revision and old_assets == public["mediaAssets"] and
                                                  public["captions"] == previous.get("captions"))
                    if args.pause_after_inventory or args.inventory_first:
                        download_plans.append((key, session, public, private))
                    if args.download and not (args.pause_after_inventory or args.inventory_first) and (not args.limit or processed < args.limit):
                        if (unchanged or video_assets_unchanged) and previous.get("state") in ("archived", "subtitles_archived") and verified_files(root, previous) and (args.subtitles_only or has_video):
                            public["state"] = "archived"
                            if video_assets_unchanged and not unchanged:
                                print(json.dumps({"state": "video_assets_reused", "entryId": session["entryId"],
                                                  "entryMetadataUpdated": True}), flush=True)
                        else:
                            public["state"] = "downloading"
                            manifest["entries"][key] = public
                            atomic_json(path, manifest)
                            runtime_stage = "download_entry"
                            print(json.dumps({"state": "download_started", "entryId": session["entryId"],
                                              "estimatedMaximumBytes": max([item.get("filesize_approx", 0) for item in private["formats"]] or [0])}), flush=True)
                            public["files"] = archive_entry(context, session, public, private, root, args.subtitles_only, include_captions, args.reserve_gib * 1024**3)
                            public["state"] = "archived" if not args.subtitles_only else "subtitles_archived"
                            public["archivedAt"] = int(time.time())
                        processed += 1
                    elif (unchanged or video_assets_unchanged) and previous.get("state") in ("archived", "subtitles_archived") and verified_files(root, previous):
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
                    details = error.details if isinstance(error, MediaAPIError) else {"code": safe_reason, "exceptionType": type(error).__name__}
                    manifest["entries"][key]["failureDetails"] = details
                    print(json.dumps({"state": "entry_failed", "entryId": session["entryId"], "stage": runtime_stage, **details}), file=sys.stderr, flush=True)
                    complete = False
                    atomic_json(path, manifest)
            manifest["scan"] = {"startedAt": manifest["scan"]["startedAt"], "completedAt": int(time.time()),
                                "complete": complete, "state": "complete" if complete else "incomplete",
                                "discoveredEntries": len(sessions.entries), "verifiedScopeEntries": len(verified_scope), "courses": courses,
                                "scope": "supplied_pages" if args.target_only else "visible_course_pages",
                                "coverageVerified": False, "discoveryComplete": discovery_complete}
            scoped_channels = [manifest["channels"][key] for key in current_channel_keys]
            scoped_streams = [manifest["streams"][key] for key in parent_scope]
            manifest["scan"]["scopeComplete"] = bool(complete and scoped_channels and (scoped_streams or healthy_empty) and
                all(value.get("state") == "verified" for value in scoped_channels + scoped_streams))
            manifest["scan"]["empty"] = healthy_empty
            # Generic UI pagination is not proof that a KAF gallery is exhaustive.
            # Therefore absent entries are never deleted or automatically marked
            # missing until a platform-specific total-count check is verified.
            atomic_json(path, manifest)
            estimated = sum(max([fmt.get("filesize_approx", 0) for fmt in record.get("formats", [])] or [0]) for record in manifest["entries"].values())
            if args.pause_after_inventory or args.inventory_first:
                print(json.dumps({"state": "inventory_ready", "entries": len(download_plans), "estimatedMaximumBytes": estimated,
                                  "freeLocalBytes": shutil.disk_usage(root).free, "manifest": str(path)}, ensure_ascii=False), flush=True)
                if args.pause_after_inventory and (not manifest["scan"]["scopeComplete"] or not download_plans):
                    print("Inventory scope is not fully verified; no video download started.", file=sys.stderr)
                    return 2
                if not args.subtitles_only:
                    allocation = plan_video_formats(download_plans, shutil.disk_usage(root).free - args.reserve_gib * 1024**3, args.video_policy)
                    manifest["formatAllocation"] = {**allocation, "reservedBytes": args.reserve_gib * 1024**3, "courseIds": courses}
                    print(json.dumps({"state": "archive_format_budget", **{key: value for key, value in manifest["formatAllocation"].items() if key != "selections"}}), flush=True)
                    atomic_json(path, manifest)
                    if allocation["missingCapacityBytes"]:
                        raise RuntimeError("insufficient_local_storage")
                if args.pause_after_inventory:
                    input("Review the saved inventory; press Enter to continue downloads in this same login, or Ctrl+C to stop. ")
                for index, (key, session, public, private) in enumerate(download_plans):
                    if args.limit and index >= args.limit:
                        break
                    record = manifest["entries"][key]
                    if record.get("state") == "archived" and verified_files(root, record):
                        continue
                    record["state"] = "downloading"
                    atomic_json(path, manifest)
                    print(json.dumps({"state": "download_started", "entryId": session["entryId"],
                                      "selectedFormat": public.get("selectedVideoFormat")}), flush=True)
                    try:
                        record["files"] = archive_entry(context, session, public, private, root, args.subtitles_only, args.with_captions or args.subtitles_only,
                                                       args.reserve_gib * 1024**3)
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
                                       "counts": counts, "state": "empty" if healthy_empty else
                                       ("complete" if counts["archived"] + counts["subtitles_archived"] == len(verified_scope) and verified_scope else "incomplete")}
                atomic_json(path, manifest)
            print(json.dumps({"entries": len(sessions.entries), "scanComplete": manifest["scan"]["complete"],
                              "scopeComplete": manifest["scan"]["scopeComplete"],
                              "archive": manifest.get("archive") if args.download else None,
                              "archiveStatus": "requested" if args.download else "not_requested",
                              "estimatedMaximumBytes": estimated, "freeLocalBytes": shutil.disk_usage(root).free,
                              "manifest": str(path)}, ensure_ascii=False))
            partial_success = bool(args.entry_id and manifest["entries"].get(f"{courses[0]}:{args.entry_id}", {}).get("state") in
                                   (("archived", "subtitles_archived") if args.download else ("discovered", "archived", "subtitles_archived")))
            return 0 if complete or partial_success else 2
        except ReauthRequired:
            manifest["scan"]["state"] = "needs_reauth"
            atomic_json(path, manifest)
            print("Login expired; progress saved. Log in again and rerun.", file=sys.stderr)
            return 2
        except Exception as error:
            manifest["scan"]["state"] = "retryable_failure"
            if args.download:
                manifest["archive"] = {"state": "incomplete", "courseIds": courses,
                                       "failureReason": "insufficient_local_storage" if str(error) == "insufficient_local_storage" else "runtime_failure",
                                       "completedAt": int(time.time())}
            atomic_json(path, manifest)
            print(json.dumps(safe_runtime_failure(error)), file=sys.stderr, flush=True)
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
