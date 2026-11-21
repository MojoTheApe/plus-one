"""Single-photo metadata hook for the InstagramIE bundled with yt-dlp 2026.10.26."""
from yt_dlp.extractor.instagram import InstagramIE, _pk_to_id
from yt_dlp.utils import ExtractorError


class _InstagramPhotoIE(InstagramIE, plugin_name='native_single_photo'):
    def _extract_product(self, product_info, *args, **kwargs):
        if not isinstance(product_info, dict) or type(product_info.get('media_type')) is not int or product_info['media_type'] != 1:
            return super()._extract_product(product_info, *args, **kwargs)

        pk = str(product_info.get('pk', ''))
        valid_pk = pk.isascii() and pk.isdigit() and not pk.startswith('0') and len(pk) <= 25
        if not valid_pk or product_info.get('carousel_media') or product_info.get('carousel_media_count') not in (None, 0, 1):
            raise ExtractorError('Unverified Instagram photo identity', expected=True)
        shortcode = _pk_to_id(pk)
        if product_info.get('code') is not None and product_info['code'] != shortcode:
            raise ExtractorError('Conflicting Instagram photo identity', expected=True)
        candidates = (product_info.get('image_versions2') or {}).get('candidates') or []
        # Native order is significant. The first candidate is the display image.
        # Instagram may supply only the URL, with dimensions on the parent.
        asset = candidates[0].get('url') if candidates and isinstance(candidates[0], dict) else None
        if not isinstance(asset, str) or not asset:
            raise ExtractorError('Instagram returned no photo file', expected=True)

        # An empty playlist carries our manifest through --dump-single-json without
        # treating a photo as a video format or letting yt-dlp request its CDN URL.
        return self.playlist_result(
            [], playlist_id=shortcode, playlist_title='Instagram photo',
            channel=(product_info.get('user') or {}).get('username'),
            instagram_single_photo={'publication_id': pk, 'url': asset},
        )
