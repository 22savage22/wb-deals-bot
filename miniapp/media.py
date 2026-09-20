"""Recheck a known WB photo before probing all basket hosts again."""
import wb
from .catalog import safe_image


def verified_photo(pid, previous=''):
    previous = safe_image(previous)
    if previous and wb._fetch_photo(previous) is not None:
        return previous
    if wb.photos(pid, limit=1):
        return safe_image(wb.photo_url(pid))
    return ''
