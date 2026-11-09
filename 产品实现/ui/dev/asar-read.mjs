#!/usr/bin/env node
/**
 * 只读读取 DSH 安装包（app.asar）里的单个文件，供本次接入核对使用。
 *
 * 不写宿主目录、不改安装包；只把需要的 README / client.js 片段打印到 stdout 或
 * 复制到本卡自己的 dev 参考目录。asar 格式：前 8 字节为头长度描述，随后是 JSON 头，
 * 数据段从 8 + 头长度 开始，文件偏移相对数据段。
 *
 * 用法：node ui/dev/asar-read.mjs "<asar 内路径>" [--out <文件>]
 */

import fs from 'node:fs'
import path from 'node:path'

const ASAR = process.env.DSH_ASAR ?? 'E:/DSH-desktop/resources/app.asar'

function readHeader(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    const headerSize = head.readUInt32LE(4)
    // 本机 app.asar 在 8 字节长度描述之后还有 8 字节定位头，JSON 从第 16 字节开始；
    // JSON 的实际长度是 headerSize - 8，数据段起点仍是 8 + headerSize。
    const jsonBuffer = Buffer.alloc(headerSize - 8)
    fs.readSync(fd, jsonBuffer, 0, jsonBuffer.length, 16)
    return { headerSize, dataOffset: 8 + headerSize, json: JSON.parse(jsonBuffer.toString('utf8')) }
  } finally {
    fs.closeSync(fd)
  }
}

function findEntry(root, asarPath) {
  const parts = asarPath.split('/').filter(Boolean)
  let node = root
  for (const part of parts) {
    if (!node || !node.files || !node.files[part]) return null
    node = node.files[part]
  }
  return node
}

function main() {
  const asarPath = process.argv[2]
  if (!asarPath) {
    console.error('用法: node ui/dev/asar-read.mjs "<asar 内路径>"')
    process.exit(2)
  }
  const outIndex = process.argv.indexOf('--out')
  const outPath = outIndex > 0 ? process.argv[outIndex + 1] : null
  const { dataOffset, json } = readHeader(ASAR)
  const entry = findEntry(json, asarPath)
  if (!entry || typeof entry.offset !== 'string') {
    console.error(`未找到文件或条目不支持: ${asarPath}`)
    process.exit(1)
  }
  const size = Number(entry.size)
  const fd = fs.openSync(ASAR, 'r')
  try {
    const buffer = Buffer.alloc(size)
    fs.readSync(fd, buffer, 0, size, dataOffset + Number(entry.offset))
    if (outPath) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
      fs.writeFileSync(outPath, buffer)
      console.error(`写入 ${outPath} (${size} B)`)
    } else {
      process.stdout.write(buffer)
    }
  } finally {
    fs.closeSync(fd)
  }
}

main()
