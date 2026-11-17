"""
Audio decoding for Whisper, independent of faster-whisper's own decoder.

faster-whisper 1.2.1 opens files with av.open(..., metadata_errors="ignore"), an option
PyAV 19 removed, which made every transcription fail. This module does the same job
(decode any audio/video file to 16 kHz mono float32) using only stable PyAV calls,
and the result is passed to Whisper as a NumPy array.
"""
import gc
import itertools

import av
import numpy as np

SAMPLE_RATE = 16000


def _skip_bad_frames(frames):
    iterator = iter(frames)
    while True:
        try:
            yield next(iterator)
        except StopIteration:
            return
        except av.error.InvalidDataError:
            continue


def decode_audio(path: str) -> np.ndarray:
    resampler = av.audio.resampler.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
    chunks = []
    with av.open(path, mode="r") as container:
        if not container.streams.audio:
            raise ValueError("This file has no audio track.")
        frames = _skip_bad_frames(container.decode(audio=0))
        for frame in itertools.chain(frames, [None]):  # None flushes the resampler
            if frame is not None:
                frame.pts = None
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray().reshape(-1))
    del resampler
    gc.collect()
    if not chunks:
        raise ValueError("No audio could be read from this file.")
    return np.concatenate(chunks).astype(np.float32) / 32768.0
