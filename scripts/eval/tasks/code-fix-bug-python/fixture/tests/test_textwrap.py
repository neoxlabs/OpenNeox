import unittest

from src.textwrap import join_lines, wrap_words


class WrapWordsTest(unittest.TestCase):
    def test_wrap_exact_width(self):
        self.assertEqual(wrap_words("one two three", 7), ["one two", "three"])

    def test_wrap_short_text(self):
        self.assertEqual(wrap_words("hi there", 20), ["hi there"])

    def test_empty_text_has_no_lines(self):
        self.assertEqual(wrap_words("", 10), [])

    def test_join_empty_lines(self):
        self.assertEqual(join_lines([]), "")

    def test_join_lines(self):
        self.assertEqual(join_lines(["a", "b"], "|"), "a|b")


if __name__ == "__main__":
    unittest.main()
