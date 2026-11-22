"""Replay public Instagram page results offline, including the pinned Post when installed."""
import base64
import copy
import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("adapter", Path(__file__).resolve().parents[1] / "scripts/instagram-media.py")
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


def code(pk):
    return base64.urlsafe_b64encode(int(pk).to_bytes(9, "big")).decode().lstrip("A")


def item(pk, kind):
    return {"pk": str(pk), "id": "opaque-relay-id", "code": code(pk), "user": {"pk": "42", "username": "fixture"},
            "taken_at": 1, "media_type": kind,
            "image_versions2": {"candidates": [{"url": f"https://image.cdninstagram.com/{pk}.jpg"}]},
            "video_versions": [{"url": f"https://image.cdninstagram.com/{pk}.mp4"}] if kind == 2 else []}


def html(*wrappers):
    required = [["RelayPrefetchedStreamCache", "next", [],
                 ["opaque-query-key", {"__bbox": {"result": {"data": {"xig_polaris_media": wrapper}}}}]] for wrapper in wrappers]
    root = {"require": [["ScheduledServerJS", "handle", [], [{"__bbox": {"require": required}}]]]}
    return '<script type="application/json" data-sjs>' + json.dumps(root) + '</script>'


def wrapper(kind, count=0):
    raw = item(64, kind)
    if count:
        raw["carousel_media"] = [item(i + 101, i % 2 + 1) for i in range(count)]
    return {"pk": "64", "id": "opaque-gql-id", "code": "BA", "gating_ruling": None, "if_not_gated_logged_out": raw}


class FixturePost:
    """Minimal CI fixture for publication_manifest; the production wheel is used when available."""
    mediaid_to_shortcode = staticmethod(code)
    _normalize_post_data = staticmethod(lambda raw: raw)

    def __init__(self, context, node):
        self._context, self._node = context, node
        self.mediaid, self.shortcode, self.owner_username = int(node["pk"]), node["code"], node["user"]["username"]
        self.caption, self.is_video = "", node["media_type"] == 2
        self.typename = {1: "GraphImage", 2: "GraphVideo", 8: "GraphSidecar"}[node["media_type"]]
        self.mediacount = len(node["carousel_media"]) if node["media_type"] == 8 else 1
        self.url = node["image_versions2"]["candidates"][0]["url"]
        self.video_url = node["video_versions"][0]["url"] if self.is_video else None

    def _field(self, *keys):
        assert keys == ("edge_sidecar_to_children", "edges")
        return [{"node": vars(child)} for child in self.get_sidecar_nodes(0, 19)]

    def get_sidecar_nodes(self, start, end):
        return [SimpleNamespace(is_video=child["media_type"] == 2, shortcode=child.get("code"),
                                display_url=child["image_versions2"]["candidates"][0]["url"],
                                video_url=child["video_versions"][0]["url"] if child["media_type"] == 2 else None)
                for child in self._node["carousel_media"][start:end + 1]]


if importlib.util.find_spec("instaloader"):
    from instaloader import Post
else:
    Post = FixturePost

# No GraphQL, profile lookup or CDN request is available while parsing HTML.
context = SimpleNamespace(iphone_support=False, is_logged_in=False)


def parse(*nodes):
    return adapter.public_manifest(html(*nodes), "BA", 20, context, Post)


def rejects(node, expected):
    try:
        parse(node)
    except ValueError as error:
        assert str(error) == expected, (expected, str(error))
    else:
        raise AssertionError("Accepted invalid page result")


for kind, count in [(1, 0), (2, 0), (8, 5), (8, 9)]:
    good = wrapper(kind, count)
    album = good["if_not_gated_logged_out"].get("carousel_media", [])
    if album:
        album[0].pop("code")
        album[0]["id"] = album[0]["pk"] + "_42"
        album[-1]["carousel_parent_id"] = "64_42"
    result = parse(good, copy.deepcopy(good))
    assert result["publicationId"] == "64" and result["count"] == (count or 1)
    assert [x["mediaId"] for x in result["items"]] == ([x["pk"] for x in album] or ["64"])
    assert [x["kind"] for x in result["items"]] == (["image" if x["media_type"] == 1 else "video" for x in album] or ["video" if kind == 2 else "image"])
    assert all(x["url"].endswith(".mp4" if x["kind"] == "video" else ".jpg") for x in result["items"])

for mutate, error in [
    (lambda n: n.update(code="BB"), "MEDIA_SOURCE_MISMATCH"),
    (lambda n: n["if_not_gated_logged_out"].update(pk="65"), "MEDIA_SOURCE_MISMATCH"),
    (lambda n: n["if_not_gated_logged_out"].update(carousel_media_count=8), "MEDIA_SOURCE_UNVERIFIED"),
    (lambda n: n["if_not_gated_logged_out"]["carousel_media"].__delitem__(slice(1, None)), "MEDIA_SOURCE_UNVERIFIED"),
    (lambda n: n["if_not_gated_logged_out"].update(has_more_carousel_media=True), "MEDIA_SOURCE_UNVERIFIED"),
    (lambda n: n["if_not_gated_logged_out"]["carousel_media"][0].update(is_video=True), "MEDIA_SOURCE_MISMATCH"),
    (lambda n: n["if_not_gated_logged_out"]["carousel_media"][1].update(__typename="XDTGraphImage"), "MEDIA_SOURCE_MISMATCH"),
    (lambda n: n["if_not_gated_logged_out"]["carousel_media"][0]["image_versions2"]["candidates"][0].update(url="https://elsewhere.example/file.jpg"), "MEDIA_SOURCE_UNVERIFIED"),
    (lambda n: n["if_not_gated_logged_out"]["carousel_media"][1].update(pk="101", code=code(101)), "MEDIA_SOURCE_UNVERIFIED"),
    (lambda n: n["if_not_gated_logged_out"]["carousel_media"][0].update(carousel_parent_id="33_42"), "MEDIA_SOURCE_MISMATCH"),
    (lambda n: n["if_not_gated_logged_out"]["carousel_media"][0].update(shortcode="BB"), "MEDIA_SOURCE_MISMATCH"),
    (lambda n: n["if_not_gated_logged_out"]["carousel_media"][0].update(pk=""), "MEDIA_SOURCE_UNVERIFIED"),
    (lambda n: n["if_not_gated_logged_out"]["carousel_media"][1].update(video_versions=[]), "MEDIA_SOURCE_UNVERIFIED"),
]:
    node = wrapper(8, 5)
    mutate(node)
    rejects(node, error)

short = wrapper(8, 5)
long = wrapper(8, 9)
for a, b in [(short, long), (long, short)]:
    try:
        parse(a, b)
    except ValueError as error:
        assert str(error) == "MEDIA_SOURCE_MISMATCH"
    else:
        raise AssertionError("Different album lengths were accepted")

gate = {"code": "BA", "pk": "64", "id": "opaque", "if_not_gated_logged_out": None,
        "gating_ruling": {"gating_type": 3, "title": "Age-restricted content"}}
for gate_type, title, expected in [(3, "Age-restricted content", "AGE_RESTRICTED"), (3, "Other", "UNAVAILABLE"),
                                   ("3", "Age-restricted content", "UNAVAILABLE"), (7, "Age-restricted content", "UNAVAILABLE")]:
    try:
        parse({**gate, "gating_ruling": {"gating_type": gate_type, "title": title}})
    except adapter.InstagramPageGate as error:
        assert error.code == expected
    else:
        raise AssertionError("Confirmed gate was ignored")
assert parse({**gate, "pk": "65", "code": "BB"}) is None
assert parse({**gate, "pk": "65", "code": "BB"}, wrapper(1))["count"] == 1
assert parse({**gate, "gating_ruling": None}) is None
assert adapter.public_manifest('<meta property="og:image" content="https://image.cdninstagram.com/preview.jpg">', "BA", 20, context, Post) is None
assert adapter.public_manifest('<script type="application/json">' + json.dumps({"related": {"xig_polaris_media": wrapper(1)}}) + '</script>', "BA", 20, context, Post) is None

# Exercise the actual resolve entry point, with an HTTP double and no credentials.
class Response:
    def __init__(self, status, data, headers):
        self.status_code, self.data, self.headers = status, data, headers

    def iter_content(self, size):
        assert size <= 65536
        yield self.data

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


class Session:
    def get(self, url, **options):
        assert url == "https://www.instagram.com/p/BA/" and options["stream"] and not options["allow_redirects"] and not self.trust_env
        calls.append("html")
        return response

    __enter__ = Response.__enter__
    __exit__ = Response.__exit__


class PostRoute(Post):
    @classmethod
    def from_shortcode(cls, context, shortcode):
        calls.append("graphql")
        assert shortcode == "BA"
        return cls(context, cls._normalize_post_data({**item(64, 1), "carousel_media": []}))


http = SimpleNamespace(Session=Session, RequestException=RuntimeError)
library = SimpleNamespace(RateController=object, Instaloader=lambda **kw: SimpleNamespace(context=context), Post=PostRoute)
with patch.dict(sys.modules, requests=http, instaloader=library):
    for status, data, expected in [(200, html(wrapper(1)), ["html"]), (200, "<html>Sign in</html>", ["html", "graphql"]),
                                   (302, "", ["html", "graphql"]), (503, "", ["html", "graphql"]),
                                   (401, "", ["html"]), (403, "", ["html"]), (404, "", ["html"]), (429, "", ["html"]),
                                   (200, html(gate), ["html"]), (200, html({**wrapper(1), "code": "BB"}), ["html"])]:
        calls = []
        response = Response(status, data.encode(), {"Retry-After": "95"})
        try:
            result = adapter.resolve("https://www.instagram.com/p/BA/?tracking=private", 20)
        except adapter.SourceWait as error:
            assert status == error.status == 429 and error.seconds == 95
        except adapter.InstagramPageGate as error:
            assert error.status == status or (status == 200 and error.code == "AGE_RESTRICTED")
        except ValueError as error:
            assert status == 200 and str(error) == "MEDIA_SOURCE_MISMATCH"
        else:
            assert result["id"] == "BA" and status in (200, 302, 503) and data not in (html(gate), html({**wrapper(1), "code": "BB"}))
        assert calls == expected
    for status, data in [(200, b'x' * 6_000_001), (200, html(wrapper(8, 1)).encode())]:
        calls = []
        response = Response(status, data, {})
        try:
            adapter.resolve("https://www.instagram.com/p/BA/", 20)
        except ValueError as error:
            assert str(error) == "MEDIA_SOURCE_UNVERIFIED"
        else:
            raise AssertionError("Partial or oversized page accepted")
        assert calls == ["html"]
print("Verified public Instagram page routing, media identity and gates")
