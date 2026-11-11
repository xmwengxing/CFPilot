/*
 * CFPilot 安卓版 —— JNI 的字符串胶水。
 *
 * ## 为什么需要这一层
 *
 * JNI 的方法签名是：
 *
 *     jstring Java_..._nativeStart(JNIEnv*, jclass, jstring)
 *
 * 注意 `jstring` **不是 C 字符串** —— 它是「Java 对象的引用」。
 * 把 Go 的 `char*` 直接当 jstring 返回，JVM 会把这个字节指针当成对象引用，
 * 结果是解析失败 + 满屏乱码（这个坑踩过）。
 *
 * 字符串的真正转换要在 JNIEnv 上做：
 *
 *     NewStringUTF(env, cstr)      C 字符串 → jstring
 *     GetStringUTFChars(env, jstr)  jstring → C 字符串
 *
 * ## 为什么不直接 include <jni.h>
 *
 * Go 的 `//export` 有个限制：**带 //export 的文件，cgo 的 preamble 里
 * 只能有声明、不能有定义**（因为 preamble 会被复制进两个 C 文件）。
 * jni.h 里有 typedef 与 static inline 函数 —— 直接 include 容易踩到这个限制。
 *
 * 所以这里的分工是：
 *   - 本文件（.c）：include jni.h，提供两个纯 C 函数做转换；
 *   - jni.go：cgo 声明这两个函数，并提供 Go 侧的包装；
 *   - export.go：只调包装，preamble 干净（只有 stdlib.h 的声明）。
 */
#include <jni.h>
#include <stdlib.h>
#include <string.h>

/*
 * cf_new_jstring：C 字符串 → jstring。
 *
 * 返回的 jstring 由 JVM 管理，调用方**不要**释放。
 */
jstring cf_new_jstring(JNIEnv *env, const char *s) {
    if (s == NULL) {
        return (*env)->NewStringUTF(env, "");
    }
    return (*env)->NewStringUTF(env, s);
}

/*
 * cf_read_jstring：jstring → C 字符串（malloc 出来的副本）。
 *
 * 调用方负责 free()（Go 侧用 C.free）。
 */
char *cf_read_jstring(JNIEnv *env, jstring s) {
    if (s == NULL) {
        return strdup("");
    }
    const char *p = (*env)->GetStringUTFChars(env, s, NULL);
    char *out = strdup(p != NULL ? p : "");
    if (p != NULL) {
        (*env)->ReleaseStringUTFChars(env, s, p);
    }
    return out;
}
