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
import { SALESFORCE_SCHEMA_PREFIX, SALESFORCE_APEX, SALESFORCE_USER } from './constants';
import {
    getEngineImportSpecifiers,
    getSalesforceSchemaImports,
    getSalesforceApexImports,
    getSalesforceUserImports,
} from './utils';
import { BabelAPI, LwcBabelPluginPass } from './types';
import type { PluginObj } from '@babel/core';


// This is useful for consumers of this package to define their options
export type { LwcBabelPluginOptions } from './types';

/**
 * The transform is done in 2 passes:
 * - First, apply in a single AST traversal the decorators and the component transformation.
 * - Then, in a second path transform class properties using the official babel plugin "babel-plugin-transform-class-properties".
 * @param api
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
                    {
                        const schemaImports = getSalesforceSchemaImports(path);
                        schemaImports.forEach(imp => {
                            //console.log("\n SCHEMA IMPORT: ", imp.node);

                            const varname = imp.node.specifiers[0].local.name;
                            const schema = imp.node.source.value.substring(SALESFORCE_SCHEMA_PREFIX.length);
                            const [objApiName, fieldApiName] = schema.split('.');
                            const newSchemaStatement = (fieldApiName === undefined)
                                ? `const ${varname} = { objectApiName: '${objApiName}' }`
                                : `const ${varname} = { objectApiName: '${objApiName}', fieldApiName: '${fieldApiName}' }`;

                            const ast: types.VariableDeclaration = transformSalesforceSchema(varname, schema);
                            //console.log('\n AST:\n', ast);

                            console.log(`SCHEMA IMPORT TRANSFORMED: \`import ${varname} from '${SALESFORCE_SCHEMA_PREFIX}${schema}'\`  -->  \`${newSchemaStatement}\``); // import USER_OBJ from "@salesforce/schema/User";

                            imp.insertBefore(ast);
                            imp.remove();
                        });
                    }

                    // Rewrite '@salesforce/apex' and '@salesforce/apex/*'
                    {
                        const apexImports = getSalesforceApexImports(path);
                        apexImports.forEach(imp => {
                            //console.log('\n APEX IMPORT: ', imp.node);

                            const origImport = imp.node.source.value;
                            if (origImport === SALESFORCE_APEX) {
                                imp.node.source.value = '@pulsarlwc/apex'; // for refreshApex() and getSObjectValue()
                            } else {
                                const regex = /\./i;
                                imp.node.source.value = imp.node.source.value.substring(SALESFORCE_APEX.length + 1).replace(regex, '/');
                                // @salesforce/apex/FooComponent.fooThing -> FooComponent/fooThing
                            }
                            // Should we change other stuff on imp.node here?

                            const neueImport = imp.node.source.value;
                            console.log(`APEX IMPORT TRANSFORMED: ${origImport}  -->  ${neueImport}`);
                        });
                    }

                    // Rewrite '@salesforce/user/*' -> '@pulsarlwc/user_*'
                    {
                        const userImports = getSalesforceUserImports(path);
                        userImports.forEach(imp => {
                            //console.log('\n APEX IMPORT: ', imp.node);

                            const origImport = imp.node.source.value;
                            imp.node.source.value = '@pulsarlwc/user_' + origImport.substring(SALESFORCE_USER.length);
                            if (origImport === SALESFORCE_USER) {
                                imp.node.source.value = '@pulsarlwc/user';
                            } else {
                                imp.node.source.value = '@pulsarlwc/user_' + origImport.substring(SALESFORCE_USER.length + 1);
                            }
                            // Should we change other stuff on imp.node here?

                            const neueImport = imp.node.source.value;
                            console.log(`USER IMPORT TRANSFORMED: ${origImport}  -->  ${neueImport}`);
                        });
                    }

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
