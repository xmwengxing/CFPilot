/*
 * CFPilot 安卓版 —— JNI 胶水层。
 *
 * Go 侧用 `-buildmode=c-shared` 编成 libcfpilot.so，导出两个 C 函数：
 *
 *     char* StartServer(char* dataDir);
 *     void  StopServer();
 *
 * 这里只做三件事：
 *   1. 把 jstring 转成 C 字符串；
 *   2. 调用 Go；
 *   3. 把返回的 C 字符串转成 jstring 并 **free()**。
 *
 * ⚠️ 内存：Go 侧返回的是 C.CString（底层 C 的 malloc），
 *    转成 jstring 后必须立刻 free()，否则每次启动都漏一份。
 */
#include <jni.h>
#include <stdlib.h>

/* Go 侧导出的函数（声明见 packages/desktop/cmd/cfpilot-android/export.go） */
extern char *StartServer(char *dataDir);
extern void StopServer(void);

JNIEXPORT jstring JNICALL
Java_com_xmwengxing_cfpilot_NativeBridge_nativeStart(JNIEnv *env, jclass clazz,
                                                     jstring dataDir) {
    const char *dir = NULL;
    if (dataDir != NULL) {
        dir = (*env)->GetStringUTFChars(env, dataDir, NULL);
    }

    char *result = StartServer((char *)dir);

    if (dir != NULL) {
        (*env)->ReleaseStringUTFChars(env, dataDir, dir);
    }

    jstring out = (*env)->NewStringUTF(env, result != NULL ? result : "{}");

    /* Go 侧用 C.CString 分配的，必须由调用方释放 */
    if (result != NULL) {
        free(result);
    }
    return out;
}

JNIEXPORT void JNICALL
Java_com_xmwengxing_cfpilot_NativeBridge_nativeStop(JNIEnv *env, jclass clazz) {
    StopServer();
}
