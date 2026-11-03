/* Code samples, kept as highlighted HTML. */
export const s1 =
  '<span class="c"># A strong tabular baseline in a few lines (scikit-learn)</span>\n<span class="k">from</span> sklearn.ensemble <span class="k">import</span> HistGradientBoostingClassifier\n<span class="k">from</span> sklearn.model_selection <span class="k">import</span> train_test_split\n\nX_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=0)\nmodel = HistGradientBoostingClassifier().fit(X_train, y_train)\nprint(<span class="s">"held-out accuracy:"</span>, model.score(X_test, y_test))';
