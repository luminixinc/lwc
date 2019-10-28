const { getSalesforceSchemaImports, getSalesforceApexImports } = require('./utils');
const { SALESFORCE_SCHEMA_PREFIX, SALESFORCE_APEX } = require('./constants');

function transformSalesforceSchema(types, varname, resource) {
    const idx = resource.indexOf('.');

    let objExpression;
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

module.exports = function(api) {
    return {
        Program(path /*, state*/) {
            // Rewrite @salesforce/schema/*
            const schemaImports = getSalesforceSchemaImports(path);
            schemaImports.forEach(imp => {
                //console.log("\n SCHEMA IMPORT: ", imp.node);

                const schema = imp.node.source.value.substring(SALESFORCE_SCHEMA_PREFIX.length);
                const varname = imp.node.specifiers[0].local.name;
                //console.log(`\n schema: ${schema} varname: ${varname}`);

                const ast = transformSalesforceSchema(api.types, varname, schema);
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
        },
    };
};
