# R8 defaults otherwise: the app is obfuscated like the real targets (RecyclerView is renamed).
# Like X's TextContentView (named in layout XML), the hooked custom text view keeps its name and setter.
-keep class dev.spoilerblocker.demo.DrawnText { public void setText(java.lang.CharSequence); }
