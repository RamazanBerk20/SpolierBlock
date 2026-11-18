package dev.spoilerblock.demo;

import android.app.Application;
import android.util.Log;

public class DemoApp extends Application {
    @Override public void onCreate() {
        super.onCreate();
        Log.i("SBDemo", "DemoApp.onCreate");
    }
}
