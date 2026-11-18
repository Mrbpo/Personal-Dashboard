import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from subtitle_timing import cues_from_segments, MAX_CUE_SECONDS


def segment(words, text=None):
    observed = [SimpleNamespace(start=start, end=end, word=word, probability=0.9)
                for start, end, word in words]
    return SimpleNamespace(text=text or ''.join(row.word for row in observed), words=observed)


class SubtitleTimingTests(unittest.TestCase):
    def test_slow_speech_pause_does_not_bind_next_phrase_to_previous_words(self):
        cues, words = cues_from_segments([segment([
            (1, 1.4, ' This'), (1.4, 2.1, ' telescopes.'),
            (18, 18.2, ' Now'), (18.2, 18.8, ' substitute'), (18.8, 19.2, ' k.')])], 30)
        self.assertEqual([(cue['start'], cue['end']) for cue in cues], [(1, 2.1), (18, 19.2)])
        self.assertEqual(cues[1]['wordStart'], 2)
        self.assertEqual(cues[1]['wordEnd'], len(words))
        self.assertEqual(''.join(cue['text'].replace(' ', '') for cue in cues), 'Thistelescopes.Nowsubstitutek.')

    def test_long_slow_sentence_is_split_at_word_edges_not_character_ratios(self):
        observed = [(index * 0.6, index * 0.6 + 0.5, ' variable' + str(index)) for index in range(30)]
        cues, words = cues_from_segments([segment(observed)], 30)
        self.assertGreater(len(cues), 2)
        self.assertEqual(sum(cue['wordEnd'] - cue['wordStart'] for cue in cues), 30)
        for cue in cues:
            self.assertLessEqual(cue['end'] - cue['start'], MAX_CUE_SECONDS)
            self.assertEqual(cue['start'], words[cue['wordStart']]['start'])
            self.assertEqual(cue['speechEnd'], words[cue['wordEnd'] - 1]['end'])
            self.assertEqual(cue['text'], ''.join(word['word'] for word in words[cue['wordStart']:cue['wordEnd']]).strip())

    def test_forty_millisecond_speech_has_readable_hold_with_honest_speech_bounds(self):
        cues, words = cues_from_segments([segment([(1, 1.04, ' f'), (4, 4.4, ' continues.')])], 10)
        self.assertEqual((cues[0]['speechStart'], cues[0]['speechEnd']), (1, 1.04))
        self.assertEqual((words[0]['start'], words[0]['end']), (1, 1.04))
        self.assertEqual((cues[0]['start'], cues[0]['end']), (1, 2))

    def test_display_hold_yields_to_following_speech_and_clip_end(self):
        cues, _ = cues_from_segments([segment([(1, 1.04, ' f'), (1.8, 1.84, ' follows.')])], 2)
        self.assertEqual([cue['end'] for cue in cues], [1.8, 2])
        self.assertEqual([cue['speechEnd'] for cue in cues], [1.04, 1.84])

    def test_word_limit_looks_back_to_clause_and_keeps_number_with_its_phrase(self):
        sentence = 'Here is the diagram with its labels, and now we can calculate exactly two of three forces acting upward.'
        observed = [(index / 3, (index + 0.8) / 3, ' ' + word)
                    for index, word in enumerate(sentence.split())]
        self.assertEqual(observed[13][2], ' two')
        cues, _ = cues_from_segments([segment(observed)], 10)
        self.assertEqual([cue['text'] for cue in cues], [
            'Here is the diagram with its labels,', 'and now we can calculate exactly two of three forces acting upward.'])
        self.assertEqual(' '.join(cue['text'] for cue in cues), sentence)

    def test_unbreakable_overlong_expression_requires_review(self):
        observed = [(index / 3, (index + 0.8) / 3, ' plus' if index % 2 else ' two') for index in range(18)]
        with self.assertRaisesRegex(ValueError, 'no safe phrase boundary'):
            cues_from_segments([segment(observed)], 10)

    def test_sentence_boundary_can_finish_short_clause_without_waiting_for_segment_end(self):
        cues, _ = cues_from_segments([segment([(0, .5, ' It'), (.5, 1, ' is'), (1, 1.4, ' zero.'),
                                               (1.5, 2, ' Next'), (2, 2.8, ' step.')])], 30)
        self.assertEqual([cue['text'] for cue in cues], ['It is zero.', 'Next step.'])

    def test_zero_duration_punctuation_is_preserved_on_observed_neighbor_span(self):
        cues, words = cues_from_segments([segment([(0, .5, ' Value'), (.5, .5, ','), (.5, 1, ' x')])], 10)
        self.assertEqual(cues[0]['text'], 'Value, x')
        self.assertEqual(words[1]['start'], words[1]['end'])
        self.assertEqual((cues[0]['start'], cues[0]['end']), (0, 1))

    def test_corroborated_isolated_point_uses_observed_audio_window_times(self):
        original = segment([(1, 1.4, ' End.'), (5, 5, ' Okay,'), (8, 8.4, ' Next.')])
        islands = Mock(return_value=[(4.8, 5.3)])
        decode = Mock(return_value=segment([(.06, .42, ' okay.')]).words)
        cues, words = cues_from_segments([original], 12, speech_islands=islands, decode_island=decode)
        islands.assert_called_once_with(4, 6)
        decode.assert_called_once_with(4.8, 5.3)
        self.assertAlmostEqual(cues[1]['speechStart'], 4.86)
        self.assertAlmostEqual(cues[1]['speechEnd'], 5.22)
        self.assertEqual(cues[1]['text'], 'Okay,')
        self.assertAlmostEqual(cues[1]['end'] - cues[1]['start'], 1)
        self.assertEqual(words[1]['realignment']['originalStart'], 5)
        self.assertEqual(words[1]['realignment']['originalEnd'], 5)
        self.assertEqual(words[1]['realignment']['observedWord'], ' okay.')

    def test_zero_point_requires_one_nearby_speech_island_within_neighbors(self):
        original = segment([(3.5, 4.3, ' End.'), (5, 5, ' Okay.'), (5.7, 6.4, ' Next.')])
        for regions in [[], [(4.2, 5.1)], [(4.5, 4.7)], [(4.7, 4.92), (5.04, 5.3)]]:
            islands, decode = Mock(return_value=regions), Mock()
            with self.subTest(regions=regions), self.assertRaisesRegex(ValueError, 'absent speech'):
                cues_from_segments([original], 10, speech_islands=islands, decode_island=decode)
            islands.assert_called_once_with(4.3, 5.7)
            decode.assert_not_called()

    def test_isolated_point_requires_unique_positive_confident_matching_interval(self):
        original = segment([(3.5, 3.9, ' End.'), (5, 5, ' Okay.'), (6.1, 6.4, ' Next.')])
        weak = segment([(.2, .4, ' okay')]).words
        weak[0].probability = .3
        for candidates in [weak, [], segment([(.2, .2, ' okay')]).words, segment([(.2, .4, ' maybe')]).words,
                           segment([(.1, .22, ' okay'), (.28, .45, ' okay')]).words,
                           segment([(.22, .6, ' okay')]).words, segment([(0, .04, ' okay')]).words]:
            with self.subTest(candidates=candidates), self.assertRaisesRegex(ValueError, 'unconfirmed isolated point'):
                cues_from_segments([original], 10, speech_islands=lambda *_: [(4.8, 5.3)],
                                   decode_island=lambda *_: candidates)

    def test_normal_cues_and_attached_zero_duration_punctuation_do_not_trigger_redecode(self):
        decode = Mock(side_effect=AssertionError('unexpected ASR re-decode'))
        source = segment([(0, .5, ' Yes'), (.5, .5, ','), (.6, 1, ' indeed.')])
        self.assertEqual(cues_from_segments([source], 10, speech_islands=decode, decode_island=decode),
                         cues_from_segments([source], 10))
        decode.assert_not_called()

    def test_pathological_word_alignment_requires_review_instead_of_truncation(self):
        cases = [segment([(1, 100, ' stretched')]), segment([(1, 2, ' kept')], 'missing content'),
                 segment([(2, 3, ' backwards'), (1, 2, ' order')]),
                 segment([(1, float('nan'), ' invalid')]), segment([(10, 11, ' outside')]),
                 SimpleNamespace(text='No word evidence', words=None)]
        for value in cases:
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'WORD_TIMING_REVIEW_REQUIRED'):
                cues_from_segments([value], 10)

    def test_multiple_segment_words_keep_source_order(self):
        cues, words = cues_from_segments([segment([(0, .5, ' The'), (.5, 1, ' result')]),
                                         segment([(1, 1.5, ' is'), (1.5, 2, ' negative.')])], 3)
        self.assertEqual(cues[0]['text'], 'The result is negative.')
        self.assertEqual([word['segmentIndex'] for word in words], [0, 0, 1, 1])


if __name__ == '__main__':
    unittest.main()
