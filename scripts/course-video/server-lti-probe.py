"""Read-only server LTI 1.1 launch probe; temporary grant is read from stdin.

No browser, third-party dependencies, cookie files, signed URL logs or passwords.
This proves the HTTP launch only; it does not claim exhaustive video inventory.
"""
import argparse
import http.cookiejar
import json
import re
import sys
from html.parser import HTMLParser
from urllib.error import HTTPError
from urllib.parse import urlencode, urljoin, urlparse
from urllib.request import HTTPCookieProcessor, Request, build_opener


class HiddenForms(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.forms = []
        self.current = None

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == "form":
            self.current = {"action": values.get("action", ""), "method": values.get("method", "get").lower(), "fields": []}
        elif tag == "input" and self.current is not None:
            if values.get("type", "text").lower() == "password":
                self.current["hasPassword"] = True
            if values.get("type", "text").lower() == "hidden" and values.get("name"):
                self.current["fields"].append((values["name"], values.get("value", "")))

    def handle_endtag(self, tag):
        if tag == "form" and self.current is not None:
            self.forms.append(self.current)
            self.current = None


def allowed(url, host):
    parsed = urlparse(url)
    return parsed.scheme == "https" and parsed.hostname == host and not parsed.username and not parsed.password


def summary(html):
    entries = sorted(set(re.findall(r"(?:entry[_I]?[iI]d[\"']?\s*[:=]\s*[\"']|/media/(?:[^/\"'<>\s]+/)*)([01]_[A-Za-z0-9]+)", html)))
    channels = sorted(set(re.findall(r"/(?:categoryid|categoryId)/(\d+)", html)))
    for value in re.findall(r"/media/(?:[^/\"'<>\s]+/)*[01]_[A-Za-z0-9]+/(\d+)", html):
        if value not in channels:
            channels.append(value)
    hosts = set()
    for value in re.findall(r"(?:https:)?//[^\s\"'<>]+", html):
        parsed = urlparse("https:" + value if value.startswith("//") else value)
        if parsed.hostname and (parsed.hostname == "kaltura.com" or parsed.hostname.endswith(".kaltura.com")):
            hosts.add(parsed.hostname)
    return {"entryIds": entries, "channelIds": channels, "observedServiceHosts": sorted(hosts),
            "hasPlayerMarkup": bool(re.search(r"kWidget|kalturaPlayer|KalturaPlayer|mwEmbed|playManifest", html)),
            "hasGalleryMarkup": bool(re.search(r"media.?gallery|galleryContent|categoryid", html, re.I)),
            "sessionCandidateCount": len(re.findall(r"(?:[\"']ks[\"']\s*:|flashvars\[ks\])", html)),
            "loginRequired": bool(re.search(r"type\s*=\s*[\"']password[\"']|/login/utorid|duosecurity", html, re.I))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--canvas-host", default="q.utoronto.ca")
    parser.add_argument("--kaf-host", default="kaltura-quercus-prod.utoronto.ca")
    args = parser.parse_args()
    payload = json.loads(sys.stdin.buffer.read(262144))
    grant = payload.get("launchUrl") or payload.get("url")
    if not isinstance(grant, str) or not allowed(grant, args.canvas_host):
        raise ValueError("invalid_grant_host")
    opener = build_opener(HTTPCookieProcessor(http.cookiejar.CookieJar()))
    headers = {"User-Agent": "StudyCourseArchive/1.0", "Accept": "text/html"}
    first = opener.open(Request(grant, headers=headers), timeout=45)
    if not allowed(first.url, args.canvas_host):
        raise ValueError("unexpected_launch_redirect")
    first_html = first.read(8 * 1024 * 1024).decode("utf-8", errors="replace")
    forms = HiddenForms()
    forms.feed(first_html)
    signed = []
    for form in forms.forms:
        names = {name for name, _ in form["fields"]}
        action = urljoin(first.url, form["action"])
        if not form.get("hasPassword") and form["method"] == "post" and "oauth_signature" in names and "lti_message_type" in names and allowed(action, args.kaf_host):
            signed.append((form, action))
    if len(signed) != 1:
        print(json.dumps({"state": "lti_form_unavailable", "httpStatus": first.status, "originHost": urlparse(first.url).hostname,
                          "signedFormCount": len(signed), "requiresInteractiveAuthorization": summary(first_html)["loginRequired"]}))
        return 2
    form, action = signed[0]
    # Signed hidden fields are copied exactly, never re-signed or logged. The
    # API grant represents the current authorized user and course placement.
    post_headers = {**headers, "Content-Type": "application/x-www-form-urlencoded", "Referer": first.url}
    second = opener.open(Request(action, data=urlencode(form["fields"]).encode(), headers=post_headers, method="POST"), timeout=45)
    if not allowed(second.url, args.kaf_host):
        raise ValueError("unexpected_kaf_redirect")
    html = second.read(8 * 1024 * 1024).decode("utf-8", errors="replace")
    result = {"state": "kaf_http_launched", "launchStatus": first.status, "kafStatus": second.status,
              "kafHost": urlparse(second.url).hostname, "hiddenFieldCount": len(form["fields"]), **summary(html)}
    print(json.dumps(result), flush=True)
    return 2 if result["loginRequired"] else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except HTTPError as error:
        print(json.dumps({"state": "http_failure", "httpStatus": error.code, "originHost": urlparse(error.url).hostname}))
        sys.exit(2)
    except Exception:
        print(json.dumps({"state": "probe_failed", "error": "invalid_input_or_network_response"}))
        sys.exit(2)
