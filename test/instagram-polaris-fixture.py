"""Offline replay of Instaloader 4.16's native and normalized carousel shapes."""
import base64
import copy
import importlib
import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("adapter", Path(__file__).resolve().parents[1] / "scripts/instagram-media.py")
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


def shortcode(pk):
    return base64.urlsafe_b64encode(int(pk).to_bytes(9, "big")).decode().lstrip("A")


def child(pk, kind):
    return {"pk": str(pk), "code": shortcode(pk), "media_type": kind,
            "image_versions2": {"candidates": [{"url": "https://scontent.example.fbcdn.net/" + str(pk) + ".jpg"}]},
            "video_versions": [{"url": "https://scontent.example.fbcdn.net/" + str(pk) + ".mp4"}] if kind == 2 else []}


def normalized_node(item):
    return {"shortcode": item.get("code", ""), "is_video": item["media_type"] == 2,
            "display_url": item["image_versions2"]["candidates"][0]["url"],
            "video_url": item["video_versions"][0]["url"] if item["video_versions"] else None}


class Context:
    iphone_support = True

    def __init__(self, parent, signed_in):
        self.parent = parent
        self.is_logged_in = signed_in
        self.web_calls = self.mobile_calls = 0

    def doc_id_graphql_query(self, _query, args, web_api):
        self.web_calls += 1
        assert args["shortcode"] == self.parent["code"] and web_api != self.is_logged_in
        return {"data": {"xdt_api__v1__media__shortcode__web_info": {"items": [self.parent]}}}

    def get_iphone_json(self, path, params):
        self.mobile_calls += 1
        assert path == "api/v1/media/" + self.parent["pk"] + "/info/" and self.is_logged_in
        return {"items": [self.parent]}


# Standard Node CI has no production Python dependencies. The same replay
# can also exercise the pinned library's actual Post.from_shortcode entry point.
installed = importlib.util.find_spec("instaloader")
if installed:
    instaloader = importlib.import_module("instaloader")
    assert instaloader.__version__ == "4.16"

for kinds in [(1, 1), (2, 2), (1, 2)]:
    for signed_in in [False, True]:
        ids = [987654321098765432, 987654321098765433]
        raw = [child(pk, kind) for pk, kind in zip(ids, kinds)]
        del raw[0]["code"]  # Some normalized edges have neither an ID nor a shortcode.
        parent = {"pk": "64", "code": "BA", "media_type": 8, "taken_at": 1, "user": {"pk": "72", "username": "fixture"},
                  "carousel_media_count": 2, "carousel_media": raw}
        edges = [{"node": normalized_node(item)} for item in raw]
        if installed:
            context = Context(parent, signed_in)
            post = instaloader.Post.from_shortcode(context, "BA")
            assert all("id" not in edge["node"] for edge in post._field("edge_sidecar_to_children", "edges"))
            result = adapter.publication_manifest(post, 20)
            assert context.web_calls == 1 and context.mobile_calls == int(signed_in and 1 in kinds)
            assert [item["mediaId"] for item in result["items"]] == list(map(str, ids))
            assert [item["kind"] for item in result["items"]] == ["image" if kind == 1 else "video" for kind in kinds]
            assert [item["url"] for item in result["items"]] == [edge["node"]["video_url" if kind == 2 else "display_url"] for edge, kind in zip(edges, kinds)]
        post_id = SimpleNamespace(shortcode="BA", mediaid_to_shortcode=shortcode)
        assert adapter.sidecar_children(post_id, parent, edges, 64) == [(str(pk), kind == 2) for pk, kind in zip(ids, kinds)]
        for mutation in ["parent", "order", "kind", "code", "url", "duplicate", "count"]:
            modified, changed = copy.deepcopy(parent), copy.deepcopy(edges)
            if mutation == "parent": modified["pk"] = "65"
            if mutation == "order": modified["carousel_media"].reverse()
            if mutation == "kind": changed[0]["node"]["is_video"] = not changed[0]["node"]["is_video"]
            if mutation == "code": changed[1]["node"]["shortcode"] = "DIFFERENT"
            if mutation == "url": changed[0]["node"]["video_url" if kinds[0] == 2 else "display_url"] = "https://scontent.example.fbcdn.net/other"
            if mutation == "duplicate": modified["carousel_media"][0]["pk"] = str(ids[1])
            if mutation == "count": modified["carousel_media_count"] = 3
            try:
                adapter.sidecar_children(post_id, modified, changed, 64)
            except ValueError as error:
                assert str(error) in {"MEDIA_SOURCE_MISMATCH", "MEDIA_SOURCE_UNVERIFIED"}
            else:
                raise AssertionError("Accepted invalid " + mutation)
print("6 Polaris fixtures passed" + (" with pinned Instaloader 4.16" if installed else ""))
