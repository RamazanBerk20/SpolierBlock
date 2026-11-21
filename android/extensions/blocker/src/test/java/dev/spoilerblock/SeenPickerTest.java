package dev.spoilerblock;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/** The picker's notes, as the contract words them (cover wording). */
public class SeenPickerTest {
    @Test public void note() {
        assertEquals("Posts that only say \"Dune\" are shown once you have seen one of these.", SeenPicker.note(1, "Dune"));
        assertEquals("This post names several works. It is shown once you have seen one for each name.", SeenPicker.note(3, "DmC: Devil May Cry"));
        assertEquals("This post is about \"Resident Evil Village\". It is shown once you mark that one.", SeenPicker.noteOne("Resident Evil Village"));
    }
}
