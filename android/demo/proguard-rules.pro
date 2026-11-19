# R8 defaults otherwise: the app is obfuscated like the real targets (RecyclerView is renamed).
# Like X's TextContentView (named in layout XML), the hooked custom text view keeps its name and setter.
-keep class dev.spoilerblock.demo.DrawnText { public void setText(java.lang.CharSequence); }
# Like X's QuoteView: the field hook reads the quoted text when the view is measured.
-keep class dev.spoilerblock.demo.QuoteBox { public java.lang.CharSequence quoted; protected void onMeasure(int, int); }
