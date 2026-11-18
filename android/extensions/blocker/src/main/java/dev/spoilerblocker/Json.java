package dev.spoilerblocker;

import java.io.IOException;
import java.io.Reader;

/**
 * Minimal streaming JSON reader (the bundled catalog is parsed without building a DOM, to bound memory) and a
 * string writer that escapes exactly like JavaScript's JSON.stringify, so index.json comes out byte-identical to Node.
 * Runs unchanged on Android and on the JVM (android.util.JsonReader is not available to JVM unit tests).
 */
final class Json {
    private final Reader in;
    private int peeked = -2; // -2: nothing peeked

    Json(Reader in) { this.in = in; }

    private int read() throws IOException {
        if (peeked != -2) { int c = peeked; peeked = -2; return c; }
        return in.read();
    }

    /** Next non-whitespace char without consuming it; -1 at end. */
    int peek() throws IOException {
        int c;
        do c = read(); while (c == ' ' || c == '\n' || c == '\r' || c == '\t');
        peeked = c;
        return c;
    }

    private void expect(char e) throws IOException {
        int c = peek();
        read();
        if (c != e) throw new IOException("bad JSON: expected '" + e + "' got " + (c < 0 ? "end" : "'" + (char) c + "'"));
    }

    void beginObject() throws IOException { expect('{'); }
    void endObject() throws IOException { expect('}'); }
    void beginArray() throws IOException { expect('['); }
    void endArray() throws IOException { expect(']'); }

    /** In an object or array: true when another member follows (consumes the separating comma). */
    boolean hasNext() throws IOException {
        int c = peek();
        if (c == ',') { read(); c = peek(); }
        return c != '}' && c != ']' && c != -1;
    }

    String nextName() throws IOException {
        String n = nextString();
        expect(':');
        return n;
    }

    boolean nextNull() throws IOException {
        if (peek() != 'n') return false;
        literal("null");
        return true;
    }

    private void literal(String s) throws IOException {
        peek();
        for (int i = 0; i < s.length(); i++) if (read() != s.charAt(i)) throw new IOException("bad JSON literal");
    }

    boolean nextBoolean() throws IOException {
        if (peek() == 't') { literal("true"); return true; }
        literal("false");
        return false;
    }

    double nextNumber() throws IOException {
        peek();
        StringBuilder sb = new StringBuilder();
        for (int c = read(); ; c = read()) {
            if ((c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E') sb.append((char) c);
            else { peeked = c; break; }
        }
        try {
            return Double.parseDouble(sb.toString());
        } catch (NumberFormatException e) {
            throw new IOException("bad JSON number");
        }
    }

    String nextString() throws IOException {
        expect('"');
        StringBuilder sb = new StringBuilder();
        for (;;) {
            int c = read();
            if (c == '"') return sb.toString();
            if (c < 0) throw new IOException("bad JSON: unterminated string");
            if (c != '\\') { sb.append((char) c); continue; }
            int e = read();
            switch (e) {
                case 'n': sb.append('\n'); break;
                case 't': sb.append('\t'); break;
                case 'r': sb.append('\r'); break;
                case 'b': sb.append('\b'); break;
                case 'f': sb.append('\f'); break;
                case 'u': {
                    int v = 0;
                    for (int i = 0; i < 4; i++) {
                        int d = Character.digit(read(), 16);
                        if (d < 0) throw new IOException("bad JSON escape");
                        v = v * 16 + d;
                    }
                    sb.append((char) v);
                    break;
                }
                default:
                    if (e < 0) throw new IOException("bad JSON: unterminated string");
                    sb.append((char) e); // \" \\ \/
            }
        }
    }

    void skipValue() throws IOException {
        int c = peek();
        if (c == '{') {
            beginObject();
            while (hasNext()) { nextName(); skipValue(); }
            endObject();
        } else if (c == '[') {
            beginArray();
            while (hasNext()) skipValue();
            endArray();
        } else if (c == '"') nextString();
        else if (c == 'n') nextNull();
        else if (c == 't' || c == 'f') nextBoolean();
        else nextNumber();
    }

    /** JSON.stringify(s) for a string: same escapes, including lone surrogates (well-formed JSON.stringify). */
    static void quote(StringBuilder out, String s) {
        out.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\b': out.append("\\b"); break;
                case '\f': out.append("\\f"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    boolean lone = Character.isHighSurrogate(c) ? !(i + 1 < s.length() && Character.isLowSurrogate(s.charAt(i + 1)))
                        : Character.isLowSurrogate(c) && !(i > 0 && Character.isHighSurrogate(s.charAt(i - 1)));
                    if (c < 0x20 || lone) out.append(String.format("\\u%04x", (int) c));
                    else out.append(c);
            }
        }
        out.append('"');
    }
}
