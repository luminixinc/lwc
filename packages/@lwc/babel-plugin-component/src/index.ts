/*
 * Copyright (c) 2023, salesforce.com, inc.
 * All rights reserved.
 * SPDX-License-Identifier: MIT
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/MIT
 */

// 2024/02/23 LUMINIX FIXME: can we chain/separate-out Pulsar-specific transformations into separate file or babel config?
import { types } from '@babel/core';

import component from './component';
import {
    decorators,
    removeImportedDecoratorSpecifiers,
    validateImportedLwcDecoratorUsage,
} from './decorators';

import dedupeImports from './dedupe-imports';
import dynamicImports from './dynamic-imports';
import scopeCssImports from './scope-css-imports';
import compilerVersionNumber from './compiler-version-number';
import { SALESFORCE_SCHEMA_PREFIX, SALESFORCE_APEX } from './constants';
import { getEngineImportSpecifiers, getSalesforceSchemaImports, getSalesforceApexImports } from './utils';
import { BabelAPI, LwcBabelPluginPass } from './types';
import type { PluginObj } from '@babel/core';


// This is useful for consumers of this package to define their options
export type { LwcBabelPluginOptions } from './types';

/**
 * The transform is done in 2 passes:
 *    - First, apply in a single AST traversal the decorators and the component transformation.
 *    - Then, in a second path transform class properties using the official babel plugin "babel-plugin-transform-class-properties".
 */
export default function LwcClassTransform(api: BabelAPI): PluginObj<LwcBabelPluginPass> {
    const { ExportDefaultDeclaration: transformCreateRegisterComponent } = component(api);
    const { Class: transformDecorators } = decorators(api);
    const { Import: transformDynamicImports } = dynamicImports();
    const { ClassBody: addCompilerVersionNumber } = compilerVersionNumber(api);

    function transformSalesforceSchema(varname: string, resource: string): types.VariableDeclaration {
        const idx = resource.indexOf('.');
    
        let objExpression: types.ObjectExpression;
        if (idx < 0) {
            objExpression = types.objectExpression([
                types.objectProperty(types.identifier('objectApiName'), types.stringLiteral(resource)),
            ]);
        } else {
            const objectApiName = resource.substring(0, idx);
            const fieldApiName = resource.substring(idx + 1);
    
            objExpression = types.objectExpression([
                types.objectProperty(
                    types.identifier('objectApiName'),
                    types.stringLiteral(objectApiName)
                ),
                types.objectProperty(
                    types.identifier('fieldApiName'),
                    types.stringLiteral(fieldApiName)
                ),
            ]);
        }
    
        const schemaTransformed = types.variableDeclaration('const', [
            types.variableDeclarator(types.identifier(varname), objExpression),
        ]);
    
        return schemaTransformed;
    }

    return {
        manipulateOptions(opts, parserOpts) {
            parserOpts.plugins.push('classProperties', [
                'decorators',
                { decoratorsBeforeExport: true },
            ]);
        },

        visitor: {
            // The LWC babel plugin is incompatible with other plugins. To get around this, we run the LWC babel plugin
            // first by running all its traversals from this Program visitor.
            Program: {
                enter(path, state) {

                    // Rewrite @salesforce/schema/*
                    const schemaImports = getSalesforceSchemaImports(path);
                    schemaImports.forEach(imp => {
                        console.log("\n SCHEMA IMPORT: ", imp.node);

                        const schema = imp.node.source.value.substring(SALESFORCE_SCHEMA_PREFIX.length);
                        const varname = imp.node.specifiers[0].local.name;
                        console.log(`\n schema: ${schema} varname: ${varname}`);

                        const ast: types.VariableDeclaration = transformSalesforceSchema(varname, schema);
                        //console.log('\n AST:\n', ast);

                        imp.insertBefore(ast);
                        imp.remove();
                    });

                    // Rewrite '@salesforce/apex' and '@salesforce/apex/*'
                    const apexImports = getSalesforceApexImports(path);
                    apexImports.forEach(imp => {
                        console.log('\n APEX IMPORT: ', imp.node);

                        if (imp.node.source.value === SALESFORCE_APEX) {
                            imp.node.source.value = '@pulsarlwc/apex'; // for refreshApex() and getSObjectValue()
                        } else {
                            const regex = /\./gi;
                            imp.node.source.value = imp.node.source.value.replace(regex, '/');
                        }
                        // Should we change other stuff on imp.node here?

                        console.log(`\n APEX IMPORT TRANSFORMED: `, imp.node);
                    });

                    const engineImportSpecifiers = getEngineImportSpecifiers(path);

                    // Validate the usage of LWC decorators.
                    validateImportedLwcDecoratorUsage(engineImportSpecifiers, state);

                    // Add ?scoped=true to *.scoped.css imports
                    scopeCssImports(api, path);
                },
                exit(path) {
                    const engineImportSpecifiers = getEngineImportSpecifiers(path);
                    removeImportedDecoratorSpecifiers(engineImportSpecifiers);

                    // Will eventually be removed to eliminate unnecessary complexity. Rollup already does this for us.
                    dedupeImports(api)(path);
                },
            },

            Import: transformDynamicImports,

            Class: transformDecorators,

            ClassBody: addCompilerVersionNumber,

            ExportDefaultDeclaration: transformCreateRegisterComponent,
        },
    };
}
