//go:build !mesh

package main

// panelWindowTitle 是普通版本身面板窗口的标题。
//
// 用户要求：横幅改为「CFPilot 部署与网络维护」，窗口标题与横幅保持一致。
const panelWindowTitle = "CFPilot 部署与网络维护"

// panelPeerTitle 是「另一个变体的窗口标题」——两变体共用端口，必须能互相唤醒。
//
// 普通版运行时，如果 +mesh 版已经在托盘里跑着，端口会被它占住；
// 这时要用 +mesh 的标题去 FindWindow 才能把那个窗口唤出来。
const panelPeerTitle = "CFPilot +mesh"
