import { PluginContext, InputPluginOption } from 'rollup'
import type { Plugin } from 'vite'
import type {
  ChromeExtensionManifest,
  ContentScript,
  ProcessorOptions
} from '../manifest'
import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'path'
import {
  isJsonString,
  normalizeJsFilename,
  normalizePathResolve,
  isObject,
  isString,
  emitFile,
  getContentFromCache
} from '../utils'
import { VITE_PLUGIN_CRX_MV3 } from '../constants'
import * as backgroundParse from './background'
import * as contentScriptsParse from './content_scripts'
import { emitAsset } from './asset'

export async function loadManifest(manifestPath: string) {
  const manifestRaw = await readFile(manifestPath, 'utf8')
  if (!isJsonString(manifestRaw)) {
    throw new Error('The manifest.json is not valid.')
  }
  const manifest = JSON.parse(manifestRaw)
  if (!manifest.name) {
    throw new Error('The name field of manifest.json is required.')
  }
  if (!manifest.version) {
    throw new Error('The version field of manifest.json is required.')
  }
  if (!manifest.manifest_version) {
    throw new Error('The manifest_version field of manifest.json is required.')
  }
  return manifest
}

export class ManifestProcessor {
  plugins: Plugin[] = []
  assetPaths: string[] = [] // css & icons
  contentScriptChunkModules: string[] = []
  webAccessibleResources: string[] = []
  srcDir: string
  serviceWorkerAbsolutePath: string | undefined
  manifest: Partial<ChromeExtensionManifest> = {}
  options: ProcessorOptions

  constructor(options: ProcessorOptions) {
    this.options = options
    this.srcDir = options.srcDir
    this.manifest = options.manifest
    this.plugins = options.viteConfig.plugins.filter(
      (p) => p.name !== VITE_PLUGIN_CRX_MV3
    )
  }

  public async doBuild(context, filePath) {
    const { rollup } = await import('rollup')
    const fileFullPath = resolve(this.srcDir, filePath)
    context.addWatchFile(fileFullPath)
    const bundle = await rollup({
      context: 'globalThis',
      input: fileFullPath,
      plugins: this.plugins as InputPluginOption
    })
    try {
      const { output } = await bundle.generate({
        entryFileNames: normalizeJsFilename(filePath)
      })
      const outputChunk = output[0]
      context.emitFile({
        type: 'asset',
        source: outputChunk.code,
        fileName: outputChunk.fileName
      })
    } finally {
      await bundle.close()
    }
  }

  public async reloadManifest(manifestPath: string) {
    this.manifest = await loadManifest(manifestPath)
    let serviceworkerPath = this.manifest.background?.service_worker
    this.serviceWorkerAbsolutePath = serviceworkerPath
      ? normalizePathResolve(this.options.srcDir, serviceworkerPath)
      : ''
    this.webAccessibleResources = []
  }

  public getHtmlPaths() {
    const manifest = this.manifest
    return [
      manifest.action?.default_popup,
      Object.values(manifest.chrome_url_overrides ?? {}),
      manifest.devtools_page,
      manifest.options_page,
      manifest.options_ui?.page,
      manifest.sandbox?.pages
    ]
      .flat()
      .filter((x) => isString(x))
      .map((p) => resolve(this.srcDir, p!))
  }

  public getContentScriptPaths() {
    let paths: string[] = []
    for (const item of this.manifest.content_scripts ?? []) {
      if (Array.isArray(item.js)) {
        paths = [...paths, ...item.js]
      }
    }
    return paths.map((p) => normalizePathResolve(this.srcDir, p!))
  }

  public async transform(code: string, id: string, context: PluginContext) {
    let data = ''
    if (this.serviceWorkerAbsolutePath === id) {
      let backgroundPath = normalizePathResolve(
        __dirname,
        'client/background.js'
      )
      let content = await getContentFromCache(
        context,
        backgroundPath,
        readFile(backgroundPath, 'utf8')
      )
      data += content
    }
    code = await contentScriptsParse.generageDynamicImportScript(
      context,
      this,
      code
    )
    code = await backgroundParse.generageDynamicImportScript(
      context,
      this,
      code
    )
    code = await backgroundParse.generageDynamicImportAsset(context, this, code)
    return data + code
  }

  //generate manifest.json
  public async generateManifest(context: PluginContext, bundle, bundleMap) {
    this.manifest = await contentScriptsParse.emitDevScript(context, this)
    let manifest = this.manifest
    for (const item of manifest.content_scripts ?? []) {
      for (const [index, script] of (item.js ?? []).entries()) {
        let scriptAbsolutePath = normalizePathResolve(
          this.options.srcDir,
          script
        )
        let chunk = bundleMap[scriptAbsolutePath]
        if (chunk) {
          let importedCss = [...chunk.viteMetadata.importedCss]
          let importedAssets = [...chunk.viteMetadata.importedAssets]
          this.webAccessibleResources = [
            ...this.webAccessibleResources,
            ...importedCss,
            ...importedAssets,
            ...chunk.imports,
            chunk.fileName
          ]
          for (const chunkImport of chunk.imports) {
            if (bundle[chunkImport]) {
              let importedCss = bundle[chunkImport].viteMetadata.importedCss
              item.css = [...(item.css ?? []), ...importedCss]
            }
          }
          if (importedCss.length) {
            item.css = [...(item.css ?? []), ...importedCss]
          }
          item.js![index] = 'contentscript-loader-' + basename(chunk.fileName)
          let content = `(function () {
            (async () => {
                  await import(
                    chrome.runtime.getURL("${chunk.fileName}")
                  );
                })().catch(console.error);
            })();`
          let outDir = this.options.viteConfig.build.outDir
          let outputPath = outDir + '/' + item.js![index]
          await emitFile(outputPath, content)
          console.log(`\n${outDir}/\x1B[32m${item.js![index]}\x1B[`)
        }
      }
    }
    if (this.serviceWorkerAbsolutePath) {
      manifest.background = {
        service_worker: bundleMap[this.serviceWorkerAbsolutePath].fileName
      }
    }
    if (manifest.action?.default_popup) {
      manifest.action.default_popup = basename(manifest.action.default_popup)
    }
    if (manifest.devtools_page) {
      manifest.devtools_page = basename(manifest.devtools_page)
    }
    if (manifest.options_page) {
      manifest.options_page = basename(manifest.options_page)
    }
    if (manifest.options_ui?.page) {
      manifest.options_ui.page = basename(manifest.options_ui.page)
    }
    if (manifest.sandbox?.pages) {
      manifest.sandbox.pages = manifest.sandbox.pages.map((page) =>
        basename(page)
      )
    }
    for (const key of Object.keys(manifest.chrome_url_overrides || {})) {
      if (manifest.chrome_url_overrides?.[key]) {
        manifest.chrome_url_overrides[key] = basename(
          manifest.chrome_url_overrides[key]
        )
      }
    }
    if (this.webAccessibleResources.length) {
      manifest.web_accessible_resources = [
        ...(manifest.web_accessible_resources ?? []),
        {
          matches: ['<all_urls>'],
          resources: this.webAccessibleResources,
          use_dynamic_url: true
        }
      ]
    }
    context.emitFile({
      type: 'asset',
      source: JSON.stringify(manifest, null, 2),
      fileName: 'manifest.json'
    })
  }

  public getAssetPaths() {
    let assetPaths: string[] = []
    const defaultIcon = this.manifest?.action?.default_icon
    if (defaultIcon && isString(defaultIcon)) {
      assetPaths = [defaultIcon]
    } else if (isObject(defaultIcon)) {
      let defaultIconPaths = Object.values(defaultIcon)
      assetPaths = [...assetPaths, ...defaultIconPaths]
    }
    if (isObject(this.manifest.icons)) {
      let iconPaths = Object.values(this.manifest.icons)
      assetPaths = [...assetPaths, ...iconPaths]
    }
    if (Array.isArray(this.manifest.content_scripts)) {
      this.manifest.content_scripts.forEach((item: ContentScript) => {
        if (Array.isArray(item.css)) {
          assetPaths = [...assetPaths, ...item.css]
        }
      })
    }
    return assetPaths
  }

  // icon & content_scripts.css
  public async generateAsset(context: PluginContext) {
    this.assetPaths = this.getAssetPaths()
    for (const path of this.assetPaths) {
      let fullPath = normalizePathResolve(this.srcDir, path)
      context.addWatchFile(fullPath)
      emitAsset(context, path, fullPath)
    }
  }
}
