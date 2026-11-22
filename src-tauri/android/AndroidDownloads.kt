package com.isidel.studiolo

import android.Manifest
import android.app.Activity
import android.content.ContentValues
import android.content.pm.PackageManager
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.webkit.MimeTypeMap
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.IOException
import java.util.Locale
import java.util.concurrent.Executors
import org.json.JSONException

@TauriPlugin(permissions = [Permission(strings = [Manifest.permission.WRITE_EXTERNAL_STORAGE], alias = "downloads")])
class AndroidDownloads(private val host: Activity) : Plugin(host) {
    private val writer = Executors.newSingleThreadExecutor()
    private val directory = "${Environment.DIRECTORY_DOWNLOADS}/Studiolo"

    @Command
    fun saveDownload(invoke: Invoke) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q && !hasLegacyPermission()) {
            requestPermissionForAlias("downloads", invoke, "downloadPermissionResult")
            return
        }
        writer.execute { writeDownload(invoke) }
    }

    @PermissionCallback
    fun downloadPermissionResult(invoke: Invoke) {
        if (hasLegacyPermission()) writer.execute { writeDownload(invoke) }
        else invoke.reject("Storage permission was denied", "download_permission_denied")
    }

    private fun hasLegacyPermission(): Boolean =
        host.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED

    private fun writeDownload(invoke: Invoke) {
        val name: String
        val bytes: ByteArray
        try {
            // Tauri's typed argument parser caps JSON strings below a 32 MiB file's Base64 length.
            val args = invoke.getArgs()
            name = sanitizeName(args.getString("name"))
            val base64 = args.getString("base64")
            if (base64.length > MAX_BASE64_LENGTH) {
                invoke.reject("Download exceeds 32 MiB", "too_large")
                return
            }
            bytes = Base64.decode(base64, Base64.DEFAULT)
        } catch (_: JSONException) {
            invoke.reject("Invalid download arguments", "invalid_download_data")
            return
        } catch (_: IllegalArgumentException) {
            invoke.reject("Invalid Base64 data", "invalid_download_data")
            return
        }
        if (bytes.size > MAX_BYTES) {
            invoke.reject("Download exceeds 32 MiB", "too_large")
            return
        }

        val savedName = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) saveToMediaStore(name, bytes)
            else saveToPublicDownloads(name, bytes)
        } catch (_: Exception) {
            invoke.reject("Could not write the download", "download_failed")
            return
        }
        invoke.resolve(JSObject().put("saved", true).put("displayPath", "$directory/$savedName"))
    }

    private fun sanitizeName(input: String): String {
        var name = input.filterNot { it.isISOControl() || it in "/\\:*?\"<>|" }
            .replace(Regex("\\.{2,}"), "")
            .trim()
            .take(200)
        // Reserve room for a collision suffix within the filesystem's 255-byte component limit.
        while (name.toByteArray().size > 240) name = name.dropLast(1)
        return name.trimEnd { it == '.' || it.isWhitespace() || it.isHighSurrogate() }.ifEmpty { "download" }
    }

    @android.annotation.TargetApi(Build.VERSION_CODES.Q)
    private fun saveToMediaStore(name: String, bytes: ByteArray): String {
        val resolver = host.contentResolver
        val extension = name.substringAfterLast('.', "").lowercase(Locale.ROOT)
        val columns = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE,
                MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension) ?: "application/octet-stream")
            put(MediaStore.Downloads.RELATIVE_PATH, directory)
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, columns)
            ?: throw IOException("Could not create a Downloads entry")
        try {
            val stream = resolver.openOutputStream(uri) ?: throw IOException("Could not open the download")
            stream.use { it.write(bytes) }
            val published = resolver.update(uri, ContentValues().apply {
                put(MediaStore.Downloads.IS_PENDING, 0)
            }, null, null)
            if (published == 0) throw IOException("Could not publish the download")
        } catch (error: Exception) {
            runCatching { resolver.delete(uri, null, null) }
            throw error
        }
        // MediaStore may rename an entry when the requested name already exists.
        return runCatching {
            resolver.query(uri, arrayOf(MediaStore.Downloads.DISPLAY_NAME), null, null, null)?.use {
                if (it.moveToFirst()) it.getString(0) else null
            }
        }.getOrNull() ?: name
    }

    @Suppress("DEPRECATION")
    private fun saveToPublicDownloads(name: String, bytes: ByteArray): String {
        val downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        val folder = File(downloads, "Studiolo")
        if (!folder.mkdirs() && !folder.isDirectory) throw IOException("Could not create the download directory")
        var file = File(folder, name)
        var copy = 1
        while (!file.createNewFile()) file = File(folder, "${copy++}-$name")
        try {
            file.outputStream().use { it.write(bytes) }
        } catch (error: Exception) {
            file.delete()
            throw error
        }
        return file.name
    }

    companion object {
        private const val MAX_BYTES = 32 * 1024 * 1024
        private const val MAX_BASE64_LENGTH = ((MAX_BYTES + 2) / 3) * 4
    }
}
