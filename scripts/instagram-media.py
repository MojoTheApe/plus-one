#!/usr/bin/env python3
"""Resolve one Instagram post to its native, ordered media; never enumerate a profile."""
import argparse
import json
import re
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlparse


class SourceWait(Exception):
    def __init__(self, seconds=60, status=None):
        self.seconds = max(1, int(seconds))
        self.status = status


def explicit_http_status(message):
    # Exceptions can echo publication URLs/IDs; their digits are not HTTP evidence.
    text = re.sub(r"https?://\S+", "", message)
    match = re.search(r"\bHTTP(?:/\d(?:\.\d)?)?(?:\s+Error|\s+status)?\s*:?\s+([45]\d{2})\b", text, re.I)
    if not match:
        match = re.search(r"\b([45]\d{2})\s+(?:Bad Request|Unauthorized|Forbidden|Not Found|Request Timeout|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b", text, re.I)
    return int(match[1]) if match else None


@contextmanager
def verified_alternate_urls(post, native_id, children=None):
    # Instaloader's logged-in high-quality URLs come from a second native API.
    # Validate that cached response BEFORE the library selects URLs by position.
    context = getattr(post, "_context", None)
    if not context or not context.iphone_support or not context.is_logged_in:
        yield
        return
    enabled = context.iphone_support
    try:
        alternate = post._iphone_struct
    except Exception as error:
        if type(error).__name__ not in {"ConnectionException", "BadResponseException", "QueryReturnedForbiddenException", "QueryReturnedNotFoundException", "LoginRequiredException"}:
            raise
        # Retain the library's GraphQL fallback without letting its URL accessor
        # retry the failed alternate API or use an unverified alternate response.
        context.iphone_support = False
    else:
        expected_type = 8 if children is not None else 2 if post.is_video else 1
        if not re.fullmatch(r"[0-9]+", str(alternate.get("pk", ""))) or alternate.get("media_type") not in {1, 2, 8}:
            raise ValueError("MEDIA_SOURCE_UNVERIFIED")
        if str(alternate.get("pk")) != str(native_id) or alternate.get("media_type") != expected_type:
            raise ValueError("MEDIA_SOURCE_MISMATCH")
        if alternate.get("code") and alternate["code"] != post.shortcode:
            raise ValueError("MEDIA_SOURCE_MISMATCH")
        if children is not None:
            if any(not re.fullmatch(r"[0-9]+", str(item.get("pk", ""))) or item.get("media_type") not in {1, 2} for item in alternate["carousel_media"]):
                raise ValueError("MEDIA_SOURCE_UNVERIFIED")
            actual = [(str(item["pk"]), item["media_type"] == 2) for item in alternate["carousel_media"]]
            if actual != children:
                raise ValueError("MEDIA_SOURCE_MISMATCH")
            if any(item.get("code") and item["code"] != post.mediaid_to_shortcode(int(item["pk"])) for item in alternate["carousel_media"]):
                raise ValueError("MEDIA_SOURCE_MISMATCH")
    try:
        yield
    finally:
        context.iphone_support = enabled


def sidecar_children(post, parent, edges, native_id):
    # Instaloader 4.16 preserves the raw Polaris carousel in the normalized
    # parent, but omits the numeric child IDs in edge_sidecar_to_children.
    raw = parent.get("carousel_media")
    if raw is not None:
        if str(parent.get("pk")) != str(native_id) or parent.get("code") != post.shortcode or parent.get("media_type") != 8:
            raise ValueError("MEDIA_SOURCE_MISMATCH")
        if not isinstance(raw, list) or len(raw) != len(edges) or parent.get("carousel_media_count", len(raw)) != len(raw):
            raise ValueError("MEDIA_SOURCE_UNVERIFIED")
    children = []
    for index, edge in enumerate(edges):
        node = edge["node"]
        is_video = node["is_video"]
        if type(is_video) is not bool:
            raise ValueError("MEDIA_SOURCE_UNVERIFIED")
        item = raw[index] if raw is not None else {}
        if raw is not None and (type(item.get("media_type")) is not int or item["media_type"] != (2 if is_video else 1)):
            raise ValueError("MEDIA_SOURCE_MISMATCH")
        media_id = str(item["pk"] if raw is not None else node["id"])
        if not re.fullmatch(r"[1-9][0-9]{0,19}", media_id) or int(media_id).bit_length() > 64:
            raise ValueError("MEDIA_SOURCE_UNVERIFIED")
        if node.get("id") is not None and str(node["id"]) != media_id:
            raise ValueError("MEDIA_SOURCE_MISMATCH")
        for shortcode in (item.get("code"), node.get("shortcode")):
            if shortcode and shortcode != post.mediaid_to_shortcode(int(media_id)):
                raise ValueError("MEDIA_SOURCE_MISMATCH")
        if raw is not None:
            # Verify the normalized position against the same raw child's
            # selected asset even when Instagram supplies no child shortcode.
            versions = item.get("video_versions") if is_video else (item.get("image_versions2") or {}).get("candidates")
            if not versions or not versions[0].get("url") or versions[0]["url"] != node.get("video_url" if is_video else "display_url"):
                raise ValueError("MEDIA_SOURCE_UNVERIFIED")
        children.append((media_id, is_video))
    if len({media_id for media_id, _ in children}) != len(children):
        raise ValueError("MEDIA_SOURCE_UNVERIFIED")
    return children


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
        edges = post._field("edge_sidecar_to_children", "edges")
        children = sidecar_children(post, getattr(post, "_node", {}), edges, native_id)
        if any(edge["node"]["is_video"] and "video_url" not in edge["node"] for edge in edges[:max_items]):
            full = post._full_metadata
            full_edges = full["edge_sidecar_to_children"]["edges"]
            if sidecar_children(post, full, full_edges, native_id) != children:
                raise ValueError("MEDIA_SOURCE_MISMATCH")
        # Sidecar videos use GraphQL URLs; only selected photos ask the library
        # for alternate high-quality URLs.
        if any(not is_video for _, is_video in children[:max_items]):
            with verified_alternate_urls(post, native_id, children):
                nodes = list(post.get_sidecar_nodes(start=0, end=max_items - 1))
        else:
            nodes = list(post.get_sidecar_nodes(start=0, end=max_items - 1))
        if len(edges) != count or len(nodes) != min(count, max_items):
            raise ValueError("MEDIA_SOURCE_UNVERIFIED")
        items = [{"index": index, "kind": "video" if node.is_video else "image",
                  "mediaId": children[index][0],
                  "url": node.video_url if node.is_video else node.display_url}
                 for index, node in enumerate(nodes)]
        if any(node.is_video != edges[index]["node"]["is_video"] for index, node in enumerate(nodes)):
            raise ValueError("MEDIA_SOURCE_UNVERIFIED")
    else:
        with verified_alternate_urls(post, native_id):
            items = [{"index": 0, "kind": "video" if post.is_video else "image",
                      "mediaId": str(native_id),
                      "url": post.video_url if post.is_video else post.url}]
    if len(items) != min(count, max_items) or any(not item["url"] or not re.fullmatch(r"[0-9]+", item["mediaId"]) for item in items) or len({item["mediaId"] for item in items}) != len(items):
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
            raise SourceWait(status=429)

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
            status, code = error.status, "RATE_LIMIT"
        elif name == "TooManyRequestsException":
            status, code = 429, "RATE_LIMIT"
        elif name == "QueryReturnedNotFoundException":
            status, code = 404, "UNAVAILABLE"
        elif name == "QueryReturnedForbiddenException":
            status, code = 403, "UNAVAILABLE"
        elif name in {"LoginRequiredException", "PrivateProfileNotFollowedException"}:
            status, code = explicit_http_status(message), "AUTH_REQUIRED"
        elif message in {"MEDIA_SOURCE_UNVERIFIED", "MEDIA_SOURCE_MISMATCH"}:
            code = message
        elif isinstance(error, (KeyError, TypeError, AttributeError)):
            code = "MEDIA_SOURCE_UNVERIFIED"
        elif isinstance(error, ImportError):
            code = "MEDIA_ADAPTER_MISSING"
        elif name in {"ConnectionException", "BadResponseException"}:
            code = "SERVICE_ERROR"
            status = explicit_http_status(message)
            if status:
                code = {400: "UNKNOWN", 401: "AUTH_REQUIRED", 403: "UNAVAILABLE", 404: "UNAVAILABLE", 429: "RATE_LIMIT"}.get(status, "SERVICE_ERROR")
        result = {"error": {"code": code, "status": status, "adapterErrorType": name,
                            **({"retryAfterSeconds": getattr(error, "seconds", 60)} if code == "RATE_LIMIT" else {})}}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
