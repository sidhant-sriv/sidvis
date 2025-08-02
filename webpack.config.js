//@ts-check

"use strict";

const path = require("path");
const CopyPlugin = require("copy-webpack-plugin");

/**@type {import('webpack').Configuration}*/
const config = {
  target: "node",
  mode: "none",

  entry: "./src/extension.ts",
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "extension.js",
    libraryTarget: "commonjs2",
  },
  devtool: false,
  externals: {
    vscode: "commonjs vscode",
  },
  resolve: {
    extensions: [".ts", ".js"],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: "ts-loader",
          },
        ],
      },
    ],
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        {
          from: path.resolve(
            __dirname,
            "src",
            "logic",
            "language-services",
            "python",
            "tree-sitter-python.wasm"
          ),
          to: ".",
        },
        {
          from: path.resolve(
            __dirname,
            "src",
            "logic",
            "language-services",
            "typescript",
            "tree-sitter-typescript.wasm"
          ),
          to: ".",
        },
        {
          from: path.resolve(
            __dirname,
            "src",
            "logic",
            "language-services",
            "java",
            "tree-sitter-java.wasm"
          ),
          to: ".",
        },
        {
          from: path.resolve(
            __dirname,
            "node_modules",
            "web-tree-sitter",
            "tree-sitter.wasm"
          ),
          to: ".",
        },
      ],
    }),
  ],
};
module.exports = config;
