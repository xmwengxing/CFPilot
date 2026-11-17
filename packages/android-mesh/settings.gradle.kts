pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // gomobile 生成的 AAR 放在 libs/ 下
        flatDir { dirs("app/libs") }
    }
}
rootProject.name = "CFPilotMesh"
include(":app")
