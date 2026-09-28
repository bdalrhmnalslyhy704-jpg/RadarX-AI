plugins { id("com.android.application") }

android {
  namespace="com.radarx.ai"
  compileSdk=37

  defaultConfig {
    applicationId="com.radarx.ai"
    minSdk=23
    targetSdk=37
    versionCode=60
    versionName="6.0.0"
  }

  buildTypes {
    release {
      isMinifyEnabled=false
      isShrinkResources=false
    }
  }
}

