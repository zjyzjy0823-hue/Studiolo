package com.isidel.studiolo

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
    override val handleBackNavigation = false

    override fun onCreate(savedInstanceState: Bundle?) {
        setTheme(R.style.Theme_studiolo_desktop)
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
    }

    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            private var awaitingPage = false

            override fun handleOnBackPressed() {
                if (awaitingPage) return
                awaitingPage = true
                webView.evaluateJavascript(
                    "window.dispatchEvent(new Event('studiolo:back', { cancelable: true }))"
                ) { unhandled ->
                    awaitingPage = false
                    if (unhandled == "true" && !isFinishing && !isDestroyed) {
                        moveTaskToBack(true)
                    }
                }
            }
        })
    }
}
