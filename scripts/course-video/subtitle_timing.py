"""Phrase cues from observed ASR word times; never distribute text over time."""
import math
import re

TIMING_PROFILE = 'word-pause-v2'
MAX_CUE_SECONDS = 7.0
MAX_CUE_WORDS = 14
PAUSE_SECONDS = 0.65
MIN_DISPLAY_SECONDS = 1.0
TIMING_CONFIG = {'maxCueSeconds': MAX_CUE_SECONDS, 'maxCueWords': MAX_CUE_WORDS,
                 'pauseSeconds': PAUSE_SECONDS, 'minDisplaySeconds': MIN_DISPLAY_SECONDS}

# Prefer a clause boundary before these words. Protect phrases that need the
# next word to make sense, such as "two of three forces" or "the integral".
CLAUSE_OPENERS = frozenset('and but or because although while when whereas if then which where '
                           'with without for in on at from after before during'.split())
CONTINUATIONS = CLAUSE_OPENERS | frozenset('a an the this these those my your our their its '
    'i you we they he she it is are was were be been being has have had do does did '
    'can could will would may might must should shall to of than as per '
    'not no very only just exactly approximately roughly about almost nearly all both each '
    'positive negative minus plus times over equals'.split())
NUMBER_WORDS = frozenset('zero one two three four five six seven eight nine ten eleven twelve thirteen '
    'fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy '
    'eighty ninety hundred thousand million billion first second third fourth half quarter'.split())
NUMBER_TOKEN = re.compile(r'[+-]?(?:\d+(?:[.,/]\d+)*|\.\d+)(?:%|st|nd|rd|th)?')


def _lexical(text):
    return re.sub(r'\s+', '', text)


def _boundary_penalty(left, right, seconds, count):
    left = left.strip()
    left_term = left.casefold().strip('"\u201c\u201d\u2019()[]')
    right_term = right.strip().casefold().strip('"\u201c\u201d\u2019()[],:;.!?')
    if not right_term:
        return None  # Keep punctuation with the preceding text.
    if re.search(r'[.!?;:]["\u201d\u2019\x27)]*$', left):
        return -4 if seconds >= 1.3 or count >= 4 else 0
    if left_term.endswith(','):
        return -2
    if (left_term in CONTINUATIONS or left_term in NUMBER_WORDS or
            NUMBER_TOKEN.fullmatch(left_term) or left_term in ('=', '+', '-', '/', '^', '×', '÷') or
            right_term in ('of', 'than', 'per', 'percent')):
        return None
    return -1 if right_term in CLAUSE_OPENERS else 2


def _cue_ranges(words, clip_duration):
    """Look back from a size limit to the best feasible phrase break.

    Each suffix considers at most MAX_CUE_WORDS possible first cues. Long
    pauses are hard boundaries. Among feasible paths, prefer clause breaks
    and readable display windows to isolated words and arbitrary hard cuts.
    """
    size = len(words)
    penalties = [math.inf] * size + [0]
    next_cut = [None] * size
    for first in range(size - 1, -1, -1):
        start = words[first]['start']
        end = start
        for last in range(first, min(size, first + MAX_CUE_WORDS)):
            word = words[last]
            if last > first and word['start'] - end >= PAUSE_SECONDS:
                break
            end = max(end, word['end'])
            seconds = end - start
            if seconds > MAX_CUE_SECONDS:
                break
            next_index = last + 1
            next_start = words[next_index]['start'] if next_index < size else clip_duration
            if seconds <= 0 or next_start < end or not math.isfinite(penalties[next_index]):
                continue
            count = next_index - first
            boundary = 0
            if next_index < size and next_start - end < PAUSE_SECONDS:
                boundary = _boundary_penalty(word['word'], words[next_index]['word'], seconds, count)
                if boundary is None:
                    continue
            penalty = penalties[next_index] + 3 + boundary
            if next_start - start < MIN_DISPLAY_SECONDS:
                penalty += 3
            if penalty <= penalties[first]:
                penalties[first], next_cut[first] = penalty, next_index
    first = 0
    while first < size:
        last = next_cut[first]
        if last is None:
            raise ValueError('WORD_TIMING_REVIEW_REQUIRED: no safe phrase boundary')
        yield first, last
        first = last


def cues_from_segments(segments, clip_duration):
    """Return (cues, words), preserving lexical order or requiring review.

    `segments` are faster-whisper segments with word_timestamps enabled. Evidence
    keeps the unmodified word observations. Display begins at the first word
    and may hold briefly after the last word for readability. The speech
    bounds remain independently traceable to the raw word intervals.
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
    cues = []
    for first, last in _cue_ranges(words, clip_duration):
        phrase = words[first:last]
        speech_start, speech_end = phrase[0]['start'], max(word['end'] for word in phrase)
        next_start = words[last]['start'] if last < len(words) else clip_duration
        display_end = min(next_start, max(speech_end, speech_start + MIN_DISPLAY_SECONDS))
        cues.append({'start': speech_start, 'end': display_end, 'speechStart': speech_start,
                     'speechEnd': speech_end, 'text': ''.join(word['word'] for word in phrase).strip(),
                     'wordStart': first, 'wordEnd': last})
    return cues, words
