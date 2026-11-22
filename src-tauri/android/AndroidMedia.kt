package com.isidel.studiolo

import android.app.Activity
import android.content.ActivityNotFoundException
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.util.Base64
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors
import org.json.JSONArray

// The Activity owns launcher registration. Pending callbacks are accessed only on the main thread.
internal object AndroidMediaBridge {
    var captureCallback: ((Boolean) -> Unit)? = null
    var pickCallback: ((List<Uri>) -> Unit)? = null
    val busy get() = captureCallback != null || pickCallback != null

    fun onCaptureResult(success: Boolean) {
        val callback = captureCallback
        captureCallback = null
        callback?.invoke(success)
    }

    fun onPickResult(uris: List<Uri>) {
        val callback = pickCallback
        pickCallback = null
        callback?.invoke(uris)
    }
}

@TauriPlugin
class AndroidMedia(private val host: Activity) : Plugin(host) {
    @Command
    fun capturePhoto(invoke: Invoke) = withLauncher(invoke) { activity ->
        var source: File? = null
        try {
            val directory = File(host.cacheDir, "media")
            if (!directory.mkdirs() && !directory.isDirectory) throw IOException("Could not create media cache")
            val output = File.createTempFile("capture-", ".jpg", directory)
            source = output
            val uri = FileProvider.getUriForFile(host, "${host.packageName}.fileprovider", output)
            AndroidMediaBridge.captureCallback = { success ->
                if (success) {
                    process(invoke, listOf(uri), output)
                } else {
                    output.delete()
                    invoke.reject("cancelled", "cancelled")
                }
            }
            activity.launchCapture(uri)
        } catch (error: Exception) {
            AndroidMediaBridge.captureCallback = null
            source?.delete()
            if (error is ActivityNotFoundException) {
                invoke.reject("No system camera available", "camera_unavailable")
            } else {
                invoke.reject("Could not launch the camera", "media_failed")
            }
        }
    }

    @Command
    fun pickImages(invoke: Invoke) = withLauncher(invoke) { activity ->
        val limit = invoke.getArgs().optInt("limit", 10).coerceIn(0, MAX_IMAGE_COUNT)
        if (limit == 0) {
            invoke.resolve(JSObject().put("items", JSONArray()))
            return@withLauncher
        }
        AndroidMediaBridge.pickCallback = { uris ->
            if (uris.isEmpty()) invoke.resolve(JSObject().put("items", JSONArray()))
            else process(invoke, uris.take(limit))
        }
        try {
            activity.launchImagePicker(limit)
        } catch (_: Exception) {
            AndroidMediaBridge.pickCallback = null
            invoke.reject("Could not launch the photo picker", "picker_unavailable")
        }
    }

    private fun withLauncher(invoke: Invoke, launch: (MainActivity) -> Unit) {
        host.runOnUiThread {
            val activity = host as? MainActivity
            when {
                activity == null || host.isFinishing || host.isDestroyed ->
                    invoke.reject("Media launcher is unavailable", "media_failed")
                AndroidMediaBridge.busy ->
                    invoke.reject("A media launcher is already open", "media_busy")
                else -> launch(activity)
            }
        }
    }

    private fun process(invoke: Invoke, uris: List<Uri>, source: File? = null) {
        worker.execute {
            val response = try {
                val items = JSONArray()
                for (uri in uris) items.put(encodeImage(uri))
                JSObject().put("items", items)
            } catch (_: MediaTooLarge) {
                host.runOnUiThread { invoke.reject("Photo exceeds the IPC size limit", "too_large") }
                return@execute
            } catch (_: Exception) {
                host.runOnUiThread { invoke.reject("Could not read or encode the photo", "media_failed") }
                return@execute
            } finally {
                source?.delete()
            }
            host.runOnUiThread { invoke.resolve(response) }
        }
    }

    private fun openImage(uri: Uri) =
        host.contentResolver.openInputStream(uri) ?: throw IOException("Could not open the photo")

    private fun encodeImage(uri: Uri): JSObject {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        openImage(uri).use { BitmapFactory.decodeStream(it, null, bounds) }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw IOException("Invalid image dimensions")

        val longEdge = maxOf(bounds.outWidth, bounds.outHeight)
        val options = BitmapFactory.Options().apply {
            inSampleSize = 1
            // BitmapFactory rounds the sample size down to a power of two.
            while ((longEdge - 1) / inSampleSize >= MAX_EDGE) inSampleSize *= 2
        }
        val transform = exifTransform(uri)
        var bitmap = openImage(uri).use { BitmapFactory.decodeStream(it, null, options) }
            ?: throw IOException("Could not decode the photo")
        try {
            val rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, transform, true)
            if (rotated !== bitmap) {
                bitmap.recycle()
                bitmap = rotated
            }
            val jpeg = ByteArrayOutputStream()
            while (true) {
                jpeg.reset()
                if (!bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, jpeg)) {
                    throw IOException("Could not encode the JPEG")
                }
                val base64Length = ((jpeg.size() + 2) / 3) * 4
                if (base64Length > MAX_BASE64_LENGTH) throw MediaTooLarge()
                if (base64Length < TARGET_BASE64_LENGTH) break

                // Keep quality at 85 for detailed photos that need a smaller IPC payload.
                val smaller = Bitmap.createScaledBitmap(
                    bitmap, (bitmap.width * 3 / 4).coerceAtLeast(1), (bitmap.height * 3 / 4).coerceAtLeast(1), true
                )
                bitmap.recycle()
                bitmap = smaller
            }
            val timestamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.ROOT).format(Date())
            return JSObject()
                .put("name", "photo-$timestamp.jpg")
                .put("mime", "image/jpeg")
                .put("base64", Base64.encodeToString(jpeg.toByteArray(), Base64.NO_WRAP))
                .put("width", bitmap.width)
                .put("height", bitmap.height)
        } finally {
            bitmap.recycle()
        }
    }

    private fun exifTransform(uri: Uri): Matrix {
        val orientation = openImage(uri).use { stream ->
            try {
                ExifInterface(stream).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
            } catch (_: IOException) {
                ExifInterface.ORIENTATION_NORMAL
            }
        }
        return Matrix().apply {
            when (orientation) {
                ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> setScale(-1f, 1f)
                ExifInterface.ORIENTATION_ROTATE_180 -> setRotate(180f)
                ExifInterface.ORIENTATION_FLIP_VERTICAL -> setScale(1f, -1f)
                ExifInterface.ORIENTATION_TRANSPOSE -> {
                    setRotate(90f)
                    postScale(-1f, 1f)
                }
                ExifInterface.ORIENTATION_ROTATE_90 -> setRotate(90f)
                ExifInterface.ORIENTATION_TRANSVERSE -> {
                    setRotate(270f)
                    postScale(-1f, 1f)
                }
                ExifInterface.ORIENTATION_ROTATE_270 -> setRotate(270f)
            }
        }
    }

    private class MediaTooLarge : IOException()

    companion object {
        internal const val MAX_IMAGE_COUNT = 20
        private const val MAX_EDGE = 2048
        private const val JPEG_QUALITY = 85
        private const val TARGET_BASE64_LENGTH = 1_500_000
        private const val MAX_BASE64_LENGTH = 8 * 1024 * 1024
        private val worker = Executors.newSingleThreadExecutor()
    }
}
