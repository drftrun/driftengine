/*
 * The Android host, as a one-module Gradle project.
 *
 * It is a *template*: the packager copies this whole directory into a staging area, drops the
 * game's build into `app/src/main/assets/www`, and builds there. Nothing a consumer owns is ever
 * written into this directory, which is what keeps a 70 MB game out of the engine's repository.
 */
pluginManagement {
  repositories {
    google()
    mavenCentral()
    gradlePluginPortal()
  }
}

dependencyResolutionManagement {
  repositories {
    google()
    mavenCentral()
  }
}

rootProject.name = "drift-android-host"
include(":app")
