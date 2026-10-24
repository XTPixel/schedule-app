import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}
// Tauri's base code omits prerelease numbers. Reserve 0..49 for beta,
// 50..98 for rc and 99 for stable, so every candidate can upgrade in place.
val momentVersionName = tauriProperties.getProperty("tauri.android.versionName", "1.0.0")
val momentBaseCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toLong()
val momentPrerelease = Regex("-(beta|rc)\\.(\\d+)$").find(momentVersionName)
val momentCandidateCode = momentPrerelease?.let {
    val number = it.groupValues[2].toInt()
    require(number in 1..49) { "Candidate number must be between 1 and 49" }
    number + if (it.groupValues[1] == "rc") 49 else 0
} ?: 99
val momentVersionCode = momentBaseCode * 100 + momentCandidateCode
require(momentVersionCode in 1..2_100_000_000) { "Android versionCode exceeds supported range" }
val momentSigningValues = listOf("MOMENT_ANDROID_KEYSTORE", "MOMENT_ANDROID_STORE_PASSWORD", "MOMENT_ANDROID_KEY_ALIAS", "MOMENT_ANDROID_KEY_PASSWORD").map { System.getenv(it) }
val momentSigningReady = momentSigningValues.all { !it.isNullOrEmpty() }
val momentQaVariant = providers.gradleProperty("momentQaVariant").orNull == "1"
require(momentSigningValues.all { it.isNullOrEmpty() } || momentSigningReady) { "All four Android signing environment variables are required" }

android {
    compileSdk = 36
    namespace = "com.personal.schedule"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = if (momentQaVariant) "com.personal.schedule.qa" else "com.personal.schedule"
        manifestPlaceholders["momentApplicationLabel"] = if (momentQaVariant) "此刻 QA" else "@string/app_name"
        manifestPlaceholders["momentActivityLabel"] = if (momentQaVariant) "此刻 QA" else "@string/main_activity_title"
        minSdk = 26
        targetSdk = 36
        versionCode = momentVersionCode.toInt()
        versionName = momentVersionName
    }
    signingConfigs {
        if (momentSigningReady) {
            create("momentRelease") {
                val keystorePath = file(momentSigningValues[0]!!)
                require(keystorePath.isFile) { "Android signing keystore does not exist" }
                storeFile = keystorePath
                storePassword = momentSigningValues[1]
                keyAlias = momentSigningValues[2]
                keyPassword = momentSigningValues[3]
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            if (momentSigningReady) signingConfig = signingConfigs.getByName("momentRelease")
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    // Same locked JSON runtime as Tauri's native notification plugin.
    implementation("com.fasterxml.jackson.core:jackson-databind:2.15.3")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")
