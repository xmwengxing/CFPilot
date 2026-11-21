//go:build mesh

package main

// panelWindowTitle 是 +mesh 版本身面板窗口的标题。
//
// 用户要求（2026-11-20）：+mesh 窗口顶部标题栏名称为「CFPilot +mesh」。
// 它与无边框自绘标题栏里的品牌字、document.title 三处保持一致。
const panelWindowTitle = "CFPilot +mesh"

// panelPeerTitle 是「另一个变体的窗口标题」——两变体共用端口，必须能互相唤醒。
//
// +mesh 版运行时，如果普通版已经在托盘里跑着，端口会被它占住；
// 这时要用普通版的标题去 FindWindow 才能把那个窗口唤出来。
const panelPeerTitle = "CFPilot 部署与网络维护"
