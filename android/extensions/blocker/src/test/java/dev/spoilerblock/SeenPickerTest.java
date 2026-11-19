package dev.spoilerblock;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/** The picker's note, as the contract words it (cover wording). */
public class SeenPickerTest {
    @Test public void note() {
        assertEquals("Posts that only say \"Dune\" stay covered until every one is marked.", SeenPicker.note(1, "Dune"));
        assertEquals("This post names several works. It stays covered until each one is marked.", SeenPicker.note(3, "DmC: Devil May Cry"));
    }
}
