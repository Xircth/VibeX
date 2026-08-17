plugins {
    id("org.jetbrains.kotlin.jvm")
}

kotlin {
    jvmToolchain(17)
}

sourceSets {
    main {
        kotlin.srcDir("src/main/kotlin")
        kotlin.srcDir("../../../docs/protocol/v1/generated/kotlin")
    }
    test {
        kotlin.srcDir("src/test/kotlin")
    }
}

dependencies {
    testImplementation(kotlin("test"))
}

tasks.test {
    useJUnitPlatform()
}
