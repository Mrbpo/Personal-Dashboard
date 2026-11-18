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


POINT_TOLERANCE = .12
LEXICAL_WORD = re.compile(r"\w+(?:['’\-]\w+)*")


def _realign_isolated_points(words, clip_duration, speech_islands, decode_island):
    """Corroborate an isolated point with a timed re-decode of the same audio."""
    attempts = 0
    previous_end = original_previous_end = 0.0
    for index, word in enumerate(words):
        anchor = word['start']
        original_end = word['end']
        next_start = words[index+1]['start'] if index+1 < len(words) else clip_duration
        if (original_end == anchor and anchor - original_previous_end >= PAUSE_SECONDS
                and next_start - anchor >= PAUSE_SECONDS):
            term = LEXICAL_WORD.findall(word['word'].casefold())
            if len(term) != 1 or attempts >= 6:
                raise ValueError('WORD_TIMING_REVIEW_REQUIRED: unconfirmed isolated point')
            attempts += 1
            window_start = max(previous_end, anchor - 1.0)
            window_end = min(next_start, anchor + 1.0)
            islands = [(start, end) for start, end in speech_islands(window_start, window_end)
                       if window_start <= start < end <= window_end
                       and max(start-anchor, anchor-end, 0) <= POINT_TOLERANCE]
            if len(islands) != 1:
                raise ValueError('WORD_TIMING_REVIEW_REQUIRED: ambiguous or absent speech at isolated point')
            island_start, island_end = islands[0]
            candidates = []
            for candidate in decode_island(island_start, island_end):
                if LEXICAL_WORD.findall(candidate.word.casefold()) != term:
                    continue
                candidates.append(candidate)
            if len(candidates) != 1:
                raise ValueError('WORD_TIMING_REVIEW_REQUIRED: unconfirmed isolated point')
            matched = candidates[0]
            start, end = island_start + matched.start, island_start + matched.end
            if (not (island_start <= start < end <= island_end + 1e-6)
                    or max(start-anchor, anchor-end, 0) > POINT_TOLERANCE
                    or not isinstance(matched.probability, (int, float))
                    or not .5 <= matched.probability <= 1):
                raise ValueError('WORD_TIMING_REVIEW_REQUIRED: unconfirmed isolated point')
            # This nested record stays clip-relative when the worker merges chunks.
            word['realignment'] = {'method': 'local-vad-word-realignment-v1', 'timestampBasis': 'clip-relative',
                                   'originalStart': anchor, 'originalEnd': anchor,
                                   'windowStart': window_start, 'windowEnd': window_end,
                                   'speechIslandStart': island_start, 'speechIslandEnd': island_end,
                                   'observedWord': matched.word, 'probability': matched.probability}
            word['start'], word['end'] = start, min(end, island_end)
        previous_end = max(previous_end, word['end'])
        original_previous_end = max(original_previous_end, original_end)


def _term(word):
    return word.strip().casefold().strip('.,;:!?"“”')


def _anchored_observations(observed, offset, left, right):
    """Find the two surrounding time-and-text anchors exactly once."""
    rows = [{'word': w.word, 'start': round(offset + w.start, 6), 'end': round(offset + w.end, 6),
             'probability': w.probability} for w in observed]
    def anchor_index(anchor):
        matches = [i for i, w in enumerate(rows)
                   if _term(w['word']) == _term(anchor['word'])
                   and abs(w['end'] - anchor['end']) <= .4
                   and abs(w['start'] - anchor['start']) <= .4]
        if len(matches) != 1:
            raise ValueError('WORD_TIMING_REVIEW_REQUIRED: ambiguous extended-word anchor')
        return matches[0]
    first, last = anchor_index(left), anchor_index(right)
    if last <= first:
        raise ValueError('WORD_TIMING_REVIEW_REQUIRED: reversed extended-word anchors')
    return rows[first:last + 1]


def _realign_extended_words(words, clip_duration, decode_context):
    """Recover a locally collapsed phrase using corroborated source observations."""
    for attempt in range(4):
        bad = next((i for i,w in enumerate(words) if w['end'] - w['start'] > MAX_CUE_SECONDS), None)
        if bad is None:
            return
        if decode_context is None or attempt == 3:
            raise ValueError('WORD_TIMING_REVIEW_REQUIRED: invalid word interval')
        left, right = bad-1, bad+1
        while left >= 0 and words[left]['start'] == words[left]['end']:
            left -= 1
        while right < len(words) and words[right]['start'] == words[right]['end']:
            right += 1
        start, end = words[bad]['start'], words[bad]['end']
        if (left < 0 or right >= len(words) or end - start > 22 or
                start - words[left]['end'] > 1 or words[right]['start'] - end > 1):
            raise ValueError('WORD_TIMING_REVIEW_REQUIRED: extended word lacks neighboring anchors')
        originals = words[left:right+1]
        windows = [(max(0, start-pad), min(clip_duration, end+pad)) for pad in (2, 3)]
        if windows[0] == windows[1]:
            raise ValueError('WORD_TIMING_REVIEW_REQUIRED: insufficient audio context')
        passes = [_anchored_observations(decode_context(a, b), a, originals[0], originals[-1])
                  for a,b in windows]
        primary, confirm = passes
        terms = [_term(w['word']) for w in primary]
        retained = iter(terms)
        if (terms != [_term(w['word']) for w in confirm] or
                not all(_term(w['word']) in retained for w in originals)):
            raise ValueError('WORD_TIMING_REVIEW_REQUIRED: contextual words disagree')
        lower = max((w['end'] for w in words[:left]), default=0.)
        upper = words[right+1]['start'] if right+1 < len(words) else clip_duration
        for rows in passes:
            last = lower
            for w in rows:
                if not (last <= w['start'] < w['end'] <= upper and
                        w['end'] - w['start'] <= MAX_CUE_SECONDS and
                        isinstance(w['probability'], (float,int)) and .3 <= w['probability'] <= 1):
                    raise ValueError('WORD_TIMING_REVIEW_REQUIRED: unsupported contextual interval')
                last = w['end']
            if sum(w['probability'] for w in rows) / len(rows) < .75:
                raise ValueError('WORD_TIMING_REVIEW_REQUIRED: low-confidence contextual speech')
        if any(abs(a[k] - b[k]) > .35 for a,b in zip(primary,confirm) for k in ('start','end')):
            raise ValueError('WORD_TIMING_REVIEW_REQUIRED: contextual timestamps disagree')
        for w in primary:
            w['segmentIndex'] = None  # This word is from a local re-decode.
        primary[0]['realignment'] = {'method':'two-context-word-realignment-v1',
                                     'timestampBasis':'clip-relative','windows':windows,
                                     'wordCount':len(primary),'originalWords':originals,'confirmingWords':confirm}
        words[left:right+1] = primary


def cues_from_segments(segments, clip_duration, *, speech_islands=None, decode_island=None, decode_context=None):
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
                    not isinstance(word.word, str) or not word.word.strip()):
                raise ValueError('WORD_TIMING_REVIEW_REQUIRED: invalid word interval')
            words.append({'start': start, 'end': end, 'word': word.word,
                          'probability': getattr(word, 'probability', None), 'segmentIndex': segment_index})
            previous_start = start
    _realign_extended_words(words, clip_duration, decode_context)
    if speech_islands is not None and decode_island is not None:
        _realign_isolated_points(words, clip_duration, speech_islands, decode_island)
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
