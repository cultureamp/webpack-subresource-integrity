/**
 * Copyright (c) 2015-present, Waysact Pty Ltd
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

var crypto = require('crypto');
var path = require('path');
var ReplaceSource = require('webpack-sources/lib/ReplaceSource');
var util = require('./util');
var WebIntegrityJsonpMainTemplatePlugin = require('./jmtp');
var HtmlWebpackPlugin;

// https://www.w3.org/TR/2016/REC-SRI-20160623/#cryptographic-hash-functions
var standardHashFuncNames = ['sha256', 'sha384', 'sha512'];

try {
  // eslint-disable-next-line global-require
  HtmlWebpackPlugin = require('html-webpack-plugin');
} catch (e) {
  if (!(e instanceof Error) || e.code !== 'MODULE_NOT_FOUND') {
    throw e;
  }
}

function SubresourceIntegrityPlugin(options) {
  var useOptions;
  if (options === null || typeof options === 'undefined') {
    useOptions = {};
  } else if (typeof options === 'object') {
    useOptions = options;
  } else {
    throw new Error('webpack-subresource-integrity: argument must be an object');
  }

  this.options = {
    enabled: true
  };

  Object.assign(this.options, useOptions);

  this.emittedMessages = {};
}

SubresourceIntegrityPlugin.prototype.emitMessage = function emitMessage(messages, message) {
  messages.push(new Error('webpack-subresource-integrity: ' + message));
};

SubresourceIntegrityPlugin.prototype.emitMessageOnce = function emitMessageOnce(messages, message) {
  if (!this.emittedMessages[message]) {
    this.emittedMessages[message] = true;
    this.emitMessage(messages, message);
  }
};

SubresourceIntegrityPlugin.prototype.warnOnce = function warn(compilation, message) {
  this.emitMessageOnce(compilation.warnings, message);
};

SubresourceIntegrityPlugin.prototype.error = function error(compilation, message) {
  this.emitMessage(compilation.errors, message);
};

SubresourceIntegrityPlugin.prototype.errorOnce = function error(compilation, message) {
  this.emitMessageOnce(compilation.errors, message);
};

SubresourceIntegrityPlugin.prototype.validateOptions = function validateOptions(compilation) {
  if (this.optionsValidated) {
    return;
  }
  this.optionsValidated = true;

  if (this.options.enabled && !compilation.compiler.options.output.crossOriginLoading) {
    this.warnOnce(
      compilation,
      'SRI requires a cross-origin policy, defaulting to "anonymous". ' +
        'Set webpack option output.crossOriginLoading to a value other than false ' +
        'to make this warning go away. ' +
        'See https://w3c.github.io/webappsec-subresource-integrity/#cross-origin-data-leakage'
    );
  }
  this.validateHashFuncNames(compilation);
};

SubresourceIntegrityPlugin.prototype.validateHashFuncNames =
  function validateHashFuncNames(compilation) {
    if (!Array.isArray(this.options.hashFuncNames)) {
      this.error(
        compilation,
        'options.hashFuncNames must be an array of hash function names, ' +
          'instead got \'' + this.options.hashFuncNames + '\'.');
      this.options.enabled = false;
    } else if (
      !this.options.hashFuncNames.every(this.validateHashFuncName.bind(this, compilation))
    ) {
      this.options.enabled = false;
    } else {
      this.warnStandardHashFunc(compilation);
    }
  };

SubresourceIntegrityPlugin.prototype.warnStandardHashFunc =
  function warnStandardHashFunc(compilation) {
    var foundStandardHashFunc = false;
    var i;
    for (i = 0; i < this.options.hashFuncNames.length; i += 1) {
      if (standardHashFuncNames.indexOf(this.options.hashFuncNames[i]) >= 0) {
        foundStandardHashFunc = true;
      }
    }
    if (!foundStandardHashFunc) {
      this.warnOnce(
        compilation,
        'It is recommended that at least one hash function is part of the set ' +
          'for which support is mandated by the specification. ' +
          'These are: ' + standardHashFuncNames.join(', ') + '. ' +
          'See http://www.w3.org/TR/SRI/#cryptographic-hash-functions for more information.');
    }
  };

SubresourceIntegrityPlugin.prototype.validateHashFuncName =
  function validateHashFuncName(compilation, hashFuncName) {
    if (typeof hashFuncName !== 'string' &&
        !(hashFuncName instanceof String)) {
      this.error(
        compilation,
        'options.hashFuncNames must be an array of hash function names, ' +
          'but contained ' + hashFuncName + '.');
      return false;
    }
    try {
      crypto.createHash(hashFuncName);
    } catch (error) {
      this.error(
        compilation,
        'Cannot use hash function \'' + hashFuncName + '\': ' +
          error.message);
      return false;
    }
    return true;
  };

/*  Given a public URL path to an asset, as generated by
 *  HtmlWebpackPlugin for use as a `<script src>` or `<link href`> URL
 *  in `index.html`, return the path to the asset, suitable as a key
 *  into `compilation.assets`.
 */
SubresourceIntegrityPlugin.prototype.hwpAssetPath = function hwpAssetPath(src) {
  return path.relative(this.hwpPublicPath, src);
};

SubresourceIntegrityPlugin.prototype.warnIfHotUpdate = function warnIfHotUpdate(
  compilation, source
) {
  if (source.indexOf('webpackHotUpdate') >= 0) {
    this.warnOnce(
      compilation,
      'webpack-subresource-integrity may interfere with hot reloading. ' +
        'Consider disabling this plugin in development mode.'
    );
  }
};

SubresourceIntegrityPlugin.prototype.replaceAsset = function replaceAsset(
  assets,
  hashByChunkId,
  chunkFile
) {
  var oldSource = assets[chunkFile].source();
  var newAsset;
  var magicMarker;
  var magicMarkerPos;
  var hashFuncNames = this.options.hashFuncNames;

  newAsset = new ReplaceSource(assets[chunkFile]);

  Array.from(hashByChunkId.entries()).forEach(function replaceMagicMarkers(idAndHash) {
    magicMarker = util.makePlaceholder(hashFuncNames, idAndHash[0]);
    magicMarkerPos = oldSource.indexOf(magicMarker);
    if (magicMarkerPos >= 0) {
      newAsset.replace(
        magicMarkerPos,
        (magicMarkerPos + magicMarker.length) - 1,
        idAndHash[1]);
    }
  });

  // eslint-disable-next-line no-param-reassign
  assets[chunkFile] = newAsset;

  newAsset.integrity = util.computeIntegrity(hashFuncNames, newAsset.source());
  return newAsset;
};

SubresourceIntegrityPlugin.prototype.processChunk = function processChunk(
  chunk, compilation, assets
) {
  var self = this;
  var newAsset;
  var hashByChunkId = new Map();

  Array.from(util.findChunks(chunk)).reverse().forEach(childChunk => {
    var sourcePath;

    // This can happen with invalid Webpack configurations
    if (childChunk.files.length === 0) return;

    sourcePath = compilation.sriChunkAssets[childChunk.id];

    if (childChunk.files.indexOf(sourcePath) < 0) {
      self.warnOnce(
        compilation,
        'Cannot determine asset for chunk ' + childChunk.id + ', computed="' + sourcePath +
          '", available=' + childChunk.files[0] + '. Please report this full error message ' +
          'along with your Webpack configuration at ' +
          'https://github.com/waysact/webpack-subresource-integrity/issues/new'
      );
      sourcePath = childChunk.files[0];
    }

    self.warnIfHotUpdate(compilation, assets[sourcePath].source());
    newAsset = self.replaceAsset(
      assets,
      hashByChunkId,
      sourcePath);
    hashByChunkId.set(childChunk.id, newAsset.integrity);
  });
};

SubresourceIntegrityPlugin.prototype.chunkAsset =
  function chunkAsset(compilation, chunk, asset) {
    if (compilation.assets[asset]) {
      // eslint-disable-next-line no-param-reassign
      compilation.sriChunkAssets[chunk.id] = asset;
    }
  };

SubresourceIntegrityPlugin.prototype.addMissingIntegrityHashes =
  function addMissingIntegrityHashes(assets) {
    var self = this;
    Object.keys(assets).forEach(function loop(assetKey) {
      var asset = assets[assetKey];
      if (!asset.integrity) {
        asset.integrity = util.computeIntegrity(self.options.hashFuncNames, asset.source());
      }
    });
  };

/*
 *  Calculate SRI values for each chunk and replace the magic
 *  placeholders by the actual values.
 */
SubresourceIntegrityPlugin.prototype.afterOptimizeAssets =
  function afterOptimizeAssets(compilation, assets) {
    var self = this;

    compilation.chunks.filter(util.isRuntimeChunk).forEach(function forEachChunk(chunk) {
      self.processChunk(chunk, compilation, assets);
    });

    this.addMissingIntegrityHashes(assets);
  };

SubresourceIntegrityPlugin.prototype.processTag =
  function processTag(compilation, tag) {
    var src = this.hwpAssetPath(util.getTagSrc(tag));
    /* eslint-disable no-param-reassign */
    var integrity = util.getIntegrityChecksumForAsset(compilation.assets, src);
    if (!Object.prototype.hasOwnProperty.call(tag.attributes, "integrity")) {
      tag.attributes.integrity = integrity;
      tag.attributes.crossorigin = compilation.compiler.options.output.crossOriginLoading || 'anonymous';
    }
    /* eslint-enable no-param-reassign */
  };

SubresourceIntegrityPlugin.prototype.alterAssetTags =
  function alterAssetTags(compilation, pluginArgs, callback) {
    /* html-webpack-plugin has added an event so we can pre-process the html tags before they
       inject them. This does the work.
    */
    var processTag = this.processTag.bind(this, compilation);
    pluginArgs.head.filter(util.filterTag).forEach(processTag);
    pluginArgs.body.filter(util.filterTag).forEach(processTag);
    callback(null, pluginArgs);
  };


/*  Add jsIntegrity and cssIntegrity properties to pluginArgs, to
 *  go along with js and css properties.  These are later
 *  accessible on `htmlWebpackPlugin.files`.
 */
SubresourceIntegrityPlugin.prototype.beforeHtmlGeneration =
  function beforeHtmlGeneration(compilation, pluginArgs, callback) {
    var self = this;
    this.hwpPublicPath = pluginArgs.assets.publicPath;
    this.addMissingIntegrityHashes(compilation.assets);

    ['js', 'css'].forEach(function addIntegrity(fileType) {
      // eslint-disable-next-line no-param-reassign
      pluginArgs.assets[fileType + 'Integrity'] =
        pluginArgs.assets[fileType].map(function assetIntegrity(filePath) {
          return util.getIntegrityChecksumForAsset(compilation.assets, self.hwpAssetPath(filePath));
        });
    });
    callback(null, pluginArgs);
  };

SubresourceIntegrityPlugin.prototype.registerJMTP = function registerJMTP(compilation) {
  var plugin = new WebIntegrityJsonpMainTemplatePlugin(this, compilation);
  if (plugin.apply) {
    plugin.apply(compilation.mainTemplate);
  } else {
    compilation.mainTemplate.apply(plugin);
  }
};

SubresourceIntegrityPlugin.prototype.registerHwpHooks =
  function registerHwpHooks(alterAssetTags, beforeHtmlGeneration, hwpCompilation) {
    var self = this;
    if (HtmlWebpackPlugin && HtmlWebpackPlugin.getHooks) {
      // HtmlWebpackPlugin >= 4
      HtmlWebpackPlugin.getHooks(hwpCompilation).beforeAssetTagGeneration.tapAsync(
        'sri',
        this.beforeHtmlGeneration.bind(this, hwpCompilation)
      );

      HtmlWebpackPlugin.getHooks(hwpCompilation).alterAssetTags.tapAsync(
        'sri',
        function cb(data, callback) {
          var processTag = self.processTag.bind(self, hwpCompilation);
          data.assetTags.scripts.filter(util.filterTag).forEach(processTag);
          data.assetTags.styles.filter(util.filterTag).forEach(processTag);
          callback(null, data);
        }
      );
    } else if (hwpCompilation.hooks.htmlWebpackPluginAlterAssetTags &&
               hwpCompilation.hooks.htmlWebpackPluginBeforeHtmlGeneration) {
      // HtmlWebpackPlugin 3
      hwpCompilation.hooks.htmlWebpackPluginAlterAssetTags.tapAsync('SriPlugin', alterAssetTags);
      hwpCompilation.hooks.htmlWebpackPluginBeforeHtmlGeneration.tapAsync('SriPlugin', beforeHtmlGeneration);
    }
  };

SubresourceIntegrityPlugin.prototype.thisCompilation =
  function thisCompilation(compiler, compilation) {
    var afterOptimizeAssets = this.afterOptimizeAssets.bind(this, compilation);
    var beforeChunkAssets = this.beforeChunkAssets.bind(this, compilation);
    var alterAssetTags = this.alterAssetTags.bind(this, compilation);
    var beforeHtmlGeneration = this.beforeHtmlGeneration.bind(this, compilation);

    this.validateOptions(compilation);

    if (!this.options.enabled) {
      return;
    }

    this.registerJMTP(compilation);

    // FIXME: refactor into separate per-compilation state
    // eslint-disable-next-line no-param-reassign
    compilation.sriChunkAssets = {};

    /*
     *  html-webpack support:
     *    Modify the asset tags before webpack injects them for anything with an integrity value.
     */
    if (compiler.hooks) {
      compilation.hooks.afterOptimizeAssets.tap('SriPlugin', afterOptimizeAssets);
      compilation.hooks.beforeChunkAssets.tap('SriPlugin', beforeChunkAssets);
      compiler.hooks.compilation.tap('HtmlWebpackPluginHooks', this.registerHwpHooks.bind(this, alterAssetTags, beforeHtmlGeneration));
    } else {
      compilation.plugin('after-optimize-assets', afterOptimizeAssets);
      compilation.plugin('before-chunk-assets', beforeChunkAssets);
      compilation.plugin('html-webpack-plugin-alter-asset-tags', alterAssetTags);
      compilation.plugin('html-webpack-plugin-before-html-generation', beforeHtmlGeneration);
    }
  };

SubresourceIntegrityPlugin.prototype.beforeChunkAssets = function afterPlugins(compilation) {
  var chunkAsset = this.chunkAsset.bind(this, compilation);
  if (compilation.hooks) {
    compilation.hooks.chunkAsset.tap('SriPlugin', chunkAsset);
  } else {
    compilation.plugin('chunk-asset', chunkAsset);
  }
};

SubresourceIntegrityPlugin.prototype.afterPlugins = function afterPlugins(compiler) {
  if (compiler.hooks) {
    compiler.hooks.thisCompilation.tap('SriPlugin', this.thisCompilation.bind(this, compiler));
  } else {
    compiler.plugin('this-compilation', this.thisCompilation.bind(this, compiler));
  }
};

SubresourceIntegrityPlugin.prototype.apply = function apply(compiler) {
  if (compiler.options.mode === "development") {
    return
  }

  if (process.env.ENVIRONMENT === "development") {
    return
  }

  if (compiler.hooks) {
    compiler.hooks.afterPlugins.tap('SriPlugin', this.afterPlugins.bind(this));
  } else {
    compiler.plugin('after-plugins', this.afterPlugins.bind(this));
  }
};

module.exports = SubresourceIntegrityPlugin;
