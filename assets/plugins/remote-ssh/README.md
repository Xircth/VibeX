---
summary: 通过 SSH 在远端安装并启动 VibeX Server，并打开新窗口接入该 Host。
---

# Remote SSH

在一台能 SSH 登录的服务器上安装 `vibex-server`，经本机隧道加入「设置 → 远程连接」，并把应用接到该 Host。Agent、工作区和终端都在远端运行。

需要本机 `ssh`。认证走系统 SSH（密钥、ssh-agent）。没有密钥时可以在连接时填写密码，可选由 Host 代为记住。VibeX 不保存私钥。远端 `vibex` 默认执行 `serve`：绑定全部网卡，并打印状态、token 与全部连接地址。

## 使用

1. 启用本插件。
2. 在配置页填写名称、主机、端口、用户。名称会出现在「远程连接」的已保存列表里。
3. 连接。插件会安装并启动远端 Host（`vibex serve`），经 SSH 隧道配对，写入「设置 → 远程连接」，并打开新窗口接入该 Host。当前窗口保持本机工作不变。
4. 成功后，已保存列表里会出现带 SSH 标记的 Host。本机窗口里该 Host 可见但不启用；只有新开的窗口启用它。
5. 改密或改登录信息：在连接历史里改，先「测试连接」，再「保存」。之后到「远程连接」对那台 Host 重新连接，才会按新 SSH 信息重建隧道。

远端安装使用官方 Host Family：本机下载后经 SSH 上传。Linux 需要 glibc 2.34+（Ubuntu 22.04 / RHEL 9）。

## 卸载

卸载后隧道关闭，插件配置清除。已保存的 SSH Host 默认保留；忘记服务器请在「设置 → 远程连接」里删除。

## 排障

- 主机密钥变化（`REMOTE HOST IDENTIFICATION HAS CHANGED`）与改密码无关。确认是自己重装或换机后，本机执行 `ssh-keygen -R <主机>` 再连。
- 装不上：看远端是否有 `curl`/`tar`。GitHub 直连失败时，本机会改走镜像再经 SSH 上传。
- Linux Host 需要 glibc 2.34+（Ubuntu 22.04 / RHEL 9）。更旧的系统（CentOS 7/8、RHEL 8）会在探测阶段失败。
- 从已保存列表再连：插件需要保持启用，以便重建隧道。
- 第一次用密码连接：在插件页填写密码即可，不必本机先配 SSH askpass。Worker 会写一份临时助手。Windows 需要已安装 OpenSSH 客户端。
