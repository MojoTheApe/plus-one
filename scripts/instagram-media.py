#!/usr/bin/env python3
"""Resolve one Instagram post to its native, ordered media; never enumerate a profile."""
import argparse
import json
import re
from pathlib import Path
from urllib.parse import urlparse


class SourceWait(Exception):
    def __init__(self, seconds=60):
        self.seconds = max(1, int(seconds))


def publication_manifest(post, max_items):
    # from_shortcode initially contains the caller's shortcode. Reading the
    # numeric native ID forces metadata retrieval before certifying identity.
    native_id = post.mediaid
    code = post.mediaid_to_shortcode(native_id)
    if post.shortcode != code:
        raise ValueError("MEDIA_SOURCE_MISMATCH")
    count = post.mediacount
    if not isinstance(count, int) or count < 1:
        raise ValueError("MEDIA_SOURCE_UNVERIFIED")
    if post.typename == "GraphSidecar":
        nodes = list(post.get_sidecar_nodes(start=0, end=max_items - 1))
        items = [{"index": index, "kind": "video" if node.is_video else "image",
                  "url": node.video_url if node.is_video else node.display_url}
                 for index, node in enumerate(nodes)]
    else:
        items = [{"index": 0, "kind": "video" if post.is_video else "image",
                  "url": post.video_url if post.is_video else post.url}]
    if len(items) != min(count, max_items) or any(not item["url"] for item in items):
        raise ValueError("MEDIA_SOURCE_UNVERIFIED")
    return {"id": code, "publicationId": str(native_id), "owner": post.owner_username,
            "url": "https://www.instagram.com/p/" + code + "/", "count": count,
            "title": (post.caption or "")[:1000], "items": items}


def resolve(url, max_items, session_file=None):
    import instaloader

    parsed = urlparse(url)
    match = re.fullmatch(r"/(?:p|reel|reels|tv)/([A-Za-z0-9_-]+)/?", parsed.path)
    if parsed.scheme != "https" or parsed.hostname not in {"instagram.com", "www.instagram.com"} or not match:
        raise ValueError("MEDIA_SOURCE_UNVERIFIED")

    class BoundedRateController(instaloader.RateController):
        def sleep(self, seconds):
            if seconds > 0:
                raise SourceWait(seconds)

        def handle_429(self, query_type):
            raise SourceWait()

    loader = instaloader.Instaloader(quiet=True, max_connection_attempts=1, request_timeout=15,
                                    rate_controller=BoundedRateController)
    if session_file:
        path = Path(session_file)
        if path.stat().st_size > 100000:
            raise ValueError("Invalid Instagram session")
        session = json.loads(path.read_text())
        username, cookies = session.get("username"), session.get("cookies")
        if not isinstance(username, str) or not re.fullmatch(r"[\w.]{1,30}", username) or not isinstance(cookies, dict) or not all(
                isinstance(key, str) and isinstance(value, str) for key, value in cookies.items()):
            raise ValueError("Invalid Instagram session")
        loader.context.load_session(username, cookies)
    return publication_manifest(instaloader.Post.from_shortcode(loader.context, match[1]), max_items)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--max-items", type=int, default=20)
    parser.add_argument("--session")
    args = parser.parse_args()
    try:
        result = resolve(args.url, max(1, min(20, args.max_items)), args.session)
    except Exception as error:
        name, message = type(error).__name__, str(error)
        status, code = None, "UNKNOWN"
        if isinstance(error, SourceWait):
            code = "RATE_LIMIT"
        elif "429" in message or name == "TooManyRequestsException":
            status, code = 429, "RATE_LIMIT"
        elif name in {"LoginRequiredException", "PrivateProfileNotFollowedException"} or "401" in message:
            status, code = 401, "AUTH_REQUIRED"
        elif name == "QueryReturnedNotFoundException":
            status, code = 404, "UNAVAILABLE"
        elif name == "QueryReturnedForbiddenException":
            status, code = 403, "UNAVAILABLE"
        elif message in {"MEDIA_SOURCE_UNVERIFIED", "MEDIA_SOURCE_MISMATCH"}:
            code = message
        elif isinstance(error, ImportError):
            code = "MEDIA_ADAPTER_MISSING"
        elif name in {"ConnectionException", "BadResponseException"}:
            code = "SERVICE_ERROR"
            http = re.search(r"\b([45]\d\d)\b", message)
            if http:
                status = int(http[1])
                code = {400: "UNKNOWN", 401: "AUTH_REQUIRED", 403: "UNAVAILABLE", 404: "UNAVAILABLE", 429: "RATE_LIMIT"}.get(status, "SERVICE_ERROR")
        result = {"error": {"code": code, "status": status, "adapterErrorType": name,
                            **({"retryAfterSeconds": getattr(error, "seconds", 60)} if code == "RATE_LIMIT" else {})}}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
