package dev.spoilerblock.demo;

import android.os.Bundle;
import android.preference.PreferenceActivity;

/** A settings screen from a preference XML, like YouTube's and X's: the demo patch adds its "SpolierBlock" row here. */
@SuppressWarnings("deprecation")
public class DemoSettings extends PreferenceActivity {
    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        addPreferencesFromResource(R.xml.demo_settings);
    }
}
