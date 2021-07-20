/*
 * Copyright (c) 2018, salesforce.com, inc.
 * All rights reserved.
 * SPDX-License-Identifier: MIT
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/MIT
 */
const path = require('path');
const { nodeResolve } = require('@rollup/plugin-node-resolve');
const typescript = require('rollup-plugin-typescript');

const { version, dependencies, peerDependencies } = require('../../package.json');
const entry = path.resolve(__dirname, '../../src/flags.ts');
const targetDirectory = path.resolve(__dirname, '../../dist');
const banner = `/**\n * Copyright (C) 2018 salesforce.com, inc.\n */`;
const footer = `/** version: ${version} */`;

function generateTargetName({ format }) {
    return ['flags', format === 'cjs' ? '.cjs' : '', '.js'].join('');
}

function rollupConfig({ format }) {
    return {
        input: entry,
        output: {
            file: path.join(targetDirectory, generateTargetName({ format })),
            format,
            banner,
            footer,
        },
        plugins: [
            nodeResolve({
                resolveOnly: [/^@lwc\//],
            }),
            typescript({
                target: 'es2017',
                typescript: require('typescript'),
            }),
        ],
        external: [...Object.keys(dependencies || {}), ...Object.keys(peerDependencies || {})],
    };
}

module.exports = [rollupConfig({ format: 'es' }), rollupConfig({ format: 'cjs' })];
