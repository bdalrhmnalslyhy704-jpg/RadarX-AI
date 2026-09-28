plugins { id("com.android.application") }

android {
  namespace = "com.radarx.ai"
  compileSdk = 37

  defaultConfig {
    applicationId = "com.radarx.ai"
    minSdk = 23
    targetSdk = 37
    versionCode = 64
    versionName = "6.4.0"
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  buildTypes {
    release {
      isMinifyEnabled = false
      isShrinkResources = false
    }
  }
}

dependencies {
  implementation("com.squareup.okhttp3:okhttp:5.5.0")
}
