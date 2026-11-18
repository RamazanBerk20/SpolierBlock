package dev.spoilerblock;

import org.json.JSONObject;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

/**
 * BERT WordPiece tokenizer for models/spoiler/tokenizer.json, written to give the same ids as transformers.js
 * (the extension's tokenizer), including its quirks: CJK spacing works on UTF-16 units, and truncation to max_length
 * happens after [CLS]/[SEP] are added, so a long sentence ends without [SEP]. Checked id for id against it by
 * WordPieceTest on the vectors of android/tools/spoiler-vectors.mjs.
 */
final class WordPiece {
    private static final String[] SPECIAL = {"[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]"}; // added_tokens, matched literally
    private static final int MAX_WORD = 100;
    private final Map<String, Integer> vocab = new HashMap<>();
    private final int unk, cls, sep;

    WordPiece(String tokenizerJson) throws Exception {
        JSONObject v = new JSONObject(tokenizerJson).getJSONObject("model").getJSONObject("vocab");
        for (Iterator<String> it = v.keys(); it.hasNext(); ) { String k = it.next(); vocab.put(k, v.getInt(k)); }
        unk = vocab.get("[UNK]"); cls = vocab.get("[CLS]"); sep = vocab.get("[SEP]");
    }

    /** input_ids of tok(text, { truncation: true, max_length }). */
    long[] encode(String text, int maxLength) {
        List<Integer> ids = new ArrayList<>();
        ids.add(cls);
        int from = 0;
        while (from <= text.length()) { // split out special tokens written in the text, as the added-tokens splitter does
            int at = text.length(), len = 0;
            for (String s : SPECIAL) { int i = text.indexOf(s, from); if (i >= 0 && (i < at || i == at && s.length() > len)) { at = i; len = s.length(); } }
            section(text.substring(from, at), ids);
            if (len == 0) break;
            ids.add(vocab.get(text.substring(at, at + len)));
            from = at + len;
        }
        ids.add(sep);
        int n = Math.min(ids.size(), maxLength);
        long[] out = new long[n];
        for (int i = 0; i < n; i++) out[i] = ids.get(i);
        return out;
    }

    private void section(String x, List<Integer> ids) {
        if (x.isEmpty()) return;
        x = normalize(x);
        for (String word : preTokenize(x)) {
            int[] cps = word.codePoints().toArray();
            if (cps.length > MAX_WORD) { ids.add(unk); continue; }
            List<Integer> sub = new ArrayList<>();
            int start = 0;
            while (start < cps.length) {
                int end = cps.length;
                Integer id = null;
                while (start < end) {
                    String s = new String(cps, start, end - start);
                    id = vocab.get(start > 0 ? "##" + s : s);
                    if (id != null) break;
                    end--;
                }
                if (id == null) { sub = null; break; }
                sub.add(id);
                start = end;
            }
            if (sub == null) ids.add(unk); else ids.addAll(sub);
        }
    }

    // ---------- BertNormalizer (clean_text, handle_chinese_chars, lowercase, strip_accents defaulting to lowercase) ----------

    static String normalize(String text) {
        StringBuilder b = new StringBuilder(text.length());
        for (int i = 0; i < text.length(); ) { // clean_text, per code point
            int cp = text.codePointAt(i);
            int lead = text.charAt(i); // JS checks charCodeAt(0) for 0 / U+FFFD
            i += Character.charCount(cp);
            if (lead == 0 || lead == 0xFFFD || isControl(cp)) continue;
            if (JsRegex.isSpace(cp)) b.append(' '); else b.appendCodePoint(cp);
        }
        StringBuilder c = new StringBuilder(b.length());
        for (int i = 0; i < b.length(); i++) { // tokenize_chinese_chars, per UTF-16 unit like transformers.js
            char ch = b.charAt(i);
            if (isChinese(ch)) c.append(' ').append(ch).append(' '); else c.append(ch);
        }
        String s = c.toString().toLowerCase(java.util.Locale.ROOT);
        s = Normalizer.normalize(s, Normalizer.Form.NFD);
        StringBuilder d = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); ) {
            int cp = s.codePointAt(i);
            i += Character.charCount(cp);
            if (Character.getType(cp) != Character.NON_SPACING_MARK) d.appendCodePoint(cp);
        }
        return d.toString();
    }

    private static boolean isControl(int cp) {
        if (cp == '\t' || cp == '\n' || cp == '\r') return false;
        int t = Character.getType(cp);
        return t == Character.CONTROL || t == Character.FORMAT || t == Character.PRIVATE_USE || t == Character.SURROGATE;
    }

    private static boolean isChinese(int cp) { // is_chinese_char; only the BMP ranges can match a UTF-16 unit
        return cp >= 0x4E00 && cp <= 0x9FFF || cp >= 0x3400 && cp <= 0x4DBF || cp >= 0xF900 && cp <= 0xFAFF;
    }

    // ---------- BertPreTokenizer: text.trim().match(/[^\s<punct>]+|[<punct>]/gu) ----------

    static List<String> preTokenize(String text) {
        List<String> out = new ArrayList<>();
        String t = JsRegex.trim(text);
        int i = 0, n = t.length();
        while (i < n) {
            int cp = t.codePointAt(i);
            int len = Character.charCount(cp);
            if (isPunct(cp)) { out.add(t.substring(i, i + len)); i += len; continue; }
            if (JsRegex.isSpace(cp)) { i += len; continue; }
            int j = i;
            while (j < n) {
                int c = t.codePointAt(j);
                if (isPunct(c) || JsRegex.isSpace(c)) break;
                j += Character.charCount(c);
            }
            out.add(t.substring(i, j));
            i = j;
        }
        return out;
    }

    private static boolean isPunct(int cp) {
        if (cp >= 0x21 && cp <= 0x2F || cp >= 0x3A && cp <= 0x40 || cp >= 0x5B && cp <= 0x60 || cp >= 0x7B && cp <= 0x7E) return true;
        switch (Character.getType(cp)) { // \p{P}
            case Character.CONNECTOR_PUNCTUATION: case Character.DASH_PUNCTUATION: case Character.START_PUNCTUATION:
            case Character.END_PUNCTUATION: case Character.INITIAL_QUOTE_PUNCTUATION: case Character.FINAL_QUOTE_PUNCTUATION:
            case Character.OTHER_PUNCTUATION:
                return true;
            default:
                return false;
        }
    }

    /** JavaScript's \s and String.prototype.trim(), which differ from Java's. */
    static final class JsRegex {
        static boolean isSpace(int c) {
            return c == ' ' || c >= 0x09 && c <= 0x0D || c == 0xA0 || c == 0x1680 || c >= 0x2000 && c <= 0x200A ||
                c == 0x2028 || c == 0x2029 || c == 0x202F || c == 0x205F || c == 0x3000 || c == 0xFEFF;
        }

        static String trim(String s) {
            int a = 0, b = s.length();
            while (a < b && isSpace(s.charAt(a))) a++;
            while (b > a && isSpace(s.charAt(b - 1))) b--;
            return s.substring(a, b);
        }
    }
}
