"""Phrase cues from observed ASR word times; never distribute text over time."""
import math
import re

TIMING_PROFILE = 'word-pause-v1'
MAX_CUE_SECONDS = 7.0
MAX_CUE_WORDS = 14
PAUSE_SECONDS = 0.65


def _lexical(text):
    return re.sub(r'\s+', '', text)


def cues_from_segments(segments, clip_duration):
    """Return (cues, words), preserving lexical order or requiring review.

    `segments` are faster-whisper segments with word_timestamps enabled. Evidence
    keeps the unmodified word observations. Cue boundaries are real word edges;
    zero-duration punctuation can share its neighbor's span, never an invented
    per-character timestamp. Missing or pathological alignment is not a success.
    """
    if not math.isfinite(clip_duration) or clip_duration <= 0:
        raise ValueError('WORD_TIMING_REVIEW_REQUIRED: invalid clip duration')
    words = []
    previous_start = -1.0
    for segment_index, segment in enumerate(segments):
        if not segment.text.strip():
            continue
        observed = list(segment.words or [])
        if not observed or _lexical(''.join(word.word for word in observed)) != _lexical(segment.text):
            raise ValueError('WORD_TIMING_REVIEW_REQUIRED: missing words or text mismatch')
        for word in observed:
            start, end = word.start, word.end
            if (not isinstance(start, (int, float)) or not isinstance(end, (int, float)) or
                    not math.isfinite(start) or not math.isfinite(end) or
                    start < 0 or end < start or end > clip_duration or start < previous_start or
                    end - start > MAX_CUE_SECONDS or not isinstance(word.word, str) or not word.word.strip()):
                raise ValueError('WORD_TIMING_REVIEW_REQUIRED: invalid word interval')
            words.append({'start': start, 'end': end, 'word': word.word,
                          'probability': getattr(word, 'probability', None), 'segmentIndex': segment_index})
            previous_start = start
    cues, pending = [], []
    pending_start = 0

    def flush():
        nonlocal pending_start
        if not pending:
            return
        start, end = pending[0]['start'], max(word['end'] for word in pending)
        if end <= start:
            raise ValueError('WORD_TIMING_REVIEW_REQUIRED: zero-duration cue')
        cues.append({'start': start, 'end': end, 'text': ''.join(word['word'] for word in pending).strip(),
                     'wordStart': pending_start, 'wordEnd': pending_start + len(pending)})
        pending_start += len(pending)
        pending.clear()

    for word in words:
        if pending:
            end = max(row['end'] for row in pending)
            pause = word['start'] - end
            would_exceed = word['end'] - pending[0]['start'] > MAX_CUE_SECONDS or len(pending) >= MAX_CUE_WORDS
            if pause >= PAUSE_SECONDS or would_exceed:
                if word['start'] < end:
                    raise ValueError('WORD_TIMING_REVIEW_REQUIRED: overlapping phrase boundary')
                flush()
        pending.append(word)
        elapsed = max(row['end'] for row in pending) - pending[0]['start']
        sentence_end = re.search(r'[.!?;:][\"\u201d\u2019\x27)]*$', word['word'].strip())
        clause_end = re.search(r',[\"\u201d\u2019\x27)]*$', word['word'].strip())
        if elapsed > 0 and ((sentence_end and (elapsed >= 1.3 or len(pending) >= 4)) or
                            (clause_end and (elapsed >= 3 or len(pending) >= 8))):
            flush()
    flush()
    if any(cues[index]['end'] > cues[index + 1]['start'] for index in range(len(cues) - 1)):
        raise ValueError('WORD_TIMING_REVIEW_REQUIRED: overlapping cues')
    return cues, words
