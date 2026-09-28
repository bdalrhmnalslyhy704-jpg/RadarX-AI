plugins { id("com.android.application") }

val radarxWebAssetsDir = layout.buildDirectory.dir("generated/radarxWebAssets").get().asFile

tasks.register<Copy>("prepareRadarXWebAssets") {
  from(rootProject.projectDir) {
    include(
      "index.html",
      "radarx-runtime-6.0.js",
      "radarx-background-client.js",
      "radarx-pulse-fusion.js",
      "RadarX_Ultimate_5.11.js",
      "RadarX_ProEngine_5.11.js",
      "radarx-live-chart.js"
    )
  }
  into(radarxWebAssetsDir)
}

android {
  namespace = "com.radarx.ai"
  compileSdk = 37

  defaultConfig {
    applicationId = "com.radarx.ai"
    minSdk = 24
    targetSdk = 37
    versionCode = 76
    versionName = "6.9.1"
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  sourceSets["main"].assets.srcDir(radarxWebAssetsDir)

  tasks.named("preBuild") {
    dependsOn("prepareRadarXWebAssets")
  }

  buildTypes {
    release {
      isMinifyEnabled = false
      isShrinkResources = false
      signingConfig = signingConfigs.getByName("debug")
    }
  }
}

dependencies {
  implementation("androidx.webkit:webkit:1.17.1")
  implementation("com.squareup.okhttp3:okhttp:5.5.0")
}
