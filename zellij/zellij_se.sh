#!/bin/bash

# 定义你想要的简单路径和文件名，例如固定在 /tmp/scrollback
new_file="/tmp/scrollback"

# 将 Zellij 传来的临时文件内容复制到新文件
cp -f "$1" "$new_file"

# 用你喜欢的编辑器打开新文件（这里以vim为例，可替换为nano, code等）
vim "$new_file"
