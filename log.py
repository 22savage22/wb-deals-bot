import logging
from logging.handlers import RotatingFileHandler

_FORMAT = logging.Formatter("%(asctime)s %(levelname)s %(message)s")


def setup(name="wb", path="bot.log"):
    logger = logging.getLogger(name)
    if logger.handlers:
        return logger
    logger.setLevel(logging.INFO)
    fh = RotatingFileHandler(path, maxBytes=1_000_000, backupCount=3, encoding="utf-8")
    fh.setFormatter(_FORMAT)
    sh = logging.StreamHandler()
    sh.setFormatter(_FORMAT)
    logger.addHandler(fh)
    logger.addHandler(sh)
    return logger
