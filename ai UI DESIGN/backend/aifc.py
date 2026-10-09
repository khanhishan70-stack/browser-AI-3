"""Minimal Python 3.13 compatibility shim for SpeechRecognition.

Python 3.13 removed the standard-library aifc module, but SpeechRecognition
3.10 still imports it at startup. This app records from the microphone, so AIFF
file parsing is not used here.
"""


class Error(Exception):
    """Raised when AIFF parsing is requested."""


def open(*_args, **_kwargs):
    """Reject AIFF parsing while preserving the old aifc.open API shape."""
    raise Error("AIFF audio files are not supported in this Python 3.13 setup.")
