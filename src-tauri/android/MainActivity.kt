package com.isidel.studiolo

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts

class MainActivity : TauriActivity() {
    override val handleBackNavigation = false

    private val captureLauncher = registerForActivityResult(object : ActivityResultContracts.TakePicture() {
        override fun createIntent(context: Context, input: Uri): Intent =
            super.createIntent(context, input).apply {
                clipData = ClipData.newRawUri("Photo", input)
                addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            }
    }, AndroidMediaBridge::onCaptureResult)

    private val pickerLauncher = registerForActivityResult(
        object : ActivityResultContracts.PickMultipleVisualMedia(AndroidMedia.MAX_IMAGE_COUNT) {
            override fun createIntent(context: Context, input: PickVisualMediaRequest): Intent =
                if (input.maxItems == 1) ActivityResultContracts.PickVisualMedia().createIntent(context, input)
                else super.createIntent(context, input)
        },
        AndroidMediaBridge::onPickResult,
    )

    internal fun launchCapture(uri: Uri) {
        captureLauncher.launch(uri)
    }

    internal fun launchImagePicker(limit: Int) {
        pickerLauncher.launch(
            PickVisualMediaRequest.Builder()
                .setMediaType(ActivityResultContracts.PickVisualMedia.ImageOnly)
                .setMaxItems(limit)
                .build()
        )
    }

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
