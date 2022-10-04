import express from 'express';
import storage from 'node-persist';
import fastStringify from 'fast-stringify';
import ptp from 'pdf-to-printer';
import fs from 'fs';
import colors from 'colors';
import path from 'path';
import { uid } from 'uid/single';
import os, { platform } from 'os';
import bodyParser from 'body-parser';
import AJV from "ajv";
import addFormats from "ajv-formats"



// Constants
const SERVER_VERSION = '0.0.9';
const PLATFORM_TO_SYSTEM = {
    win32: 'Windows',
    darwin: 'Mac',
    linux: 'Linux',
};
var SYSTEM;
try {
    SYSTEM = PLATFORM_TO_SYSTEM[os.platform().toString()];
} catch (e) {
    console.log(`Error: Platform ${os.platform()} not supported.`.red.bold);
    process.exit(1);
}

const PORT = 3000;
const PRINTERS = {
    available: [],
    any: async function () {
        return this.available.length > 1;
    },
    isAvailable: async function (deviceId) {
        return this.available.includes(deviceId);
    }
};

const app = express();
const requestIDs = [];
const ajv = new AJV();
addFormats(ajv);

const persistent = {
    templates: null,
    printers: null
};

//Validators
/**
 * JSON SCHEMAS AND COMPILED VALIDATORS
 */
const JSONValidators = {
    schemas: {
        all: {
            type: "object",
            properties: {
                printer: { type: "string" },
                datatype: {
                    type: "string",
                    enum: ["PDF", "ZPL"]
                },
            },
            required: ["printer", "datatype"],
            additionalProperties: true
        },
        pdf: {
            type: "object",
            properties: {
                printer: { type: "string" },
                datatype: {
                    type: "string",
                    const: "PDF"
                },
                content: { type: "string" }
            },
            required: ["printer", "datatype", "content"],
            additionalProperties: false
        },
        zpl: {
            type: "object",
            properties: {
                printer: { type: "string" },
                datatype: {
                    type: "string",
                    const: "ZPL"
                },
            },
            required: ["printer", "datatype"],
            additionalProperties: true
        },

        net: { //networked device. IP + deviceName
            type: "object",
            properties: {
                deviceId: { type: "string" },
                address: {
                    type: "string",
                    enum: ["ipv4", "ipv6"]
                },
                ipv4: {
                    type: "string",
                    format: 'ipv4'
                },
                ipv6: {
                    type: "string",
                    format: 'ipv6'
                }
            },
            required: ["deviceId", "address"],
            additionalProperties: true
        },
        ip4: {
            type: "object",
            properties: {
                ip: {
                    type: "string",
                    format: 'ipv4'
                }
            }
        },
        ip6: {
            type: "object",
            properties: {
                ip: {
                    type: "string",
                    format: 'ipv6'
                }
            }
        },

    },
    PDF: null,
    ZPL: null,
    ALL: null,
    IP4: null,
    IP6: null,
    DEVICE: null,
    IP_ADDRESS: null,
    init: function () {
        this.ALL = ajv.compile(this.schemas.all);
        this.PDF = ajv.compile(this.schemas.pdf);
        this.ZPL = ajv.compile(this.schemas.zpl);
        this.NET = ajv.compile(this.schemas.net);
        this.IP4 = ajv.compile(this.schemas.ip4);
        this.IP6 = ajv.compile(this.schemas.ip6);
        //this.IPA = ajv.compile(this.schemas.ip); 
        delete this.init;
        return this;
    }
};

/**
 * Asynchronous function that accepts either ipv4 || ipv6 strings and determines whether the
 * given string is an ipv4 or ipv6 address and whether or not it is a valid ip address, returning an object that contains
 * the results.
 * 
 * Must be run after the compileJSONValidators step, as it is reliant on the Validators compiled by Ajv with the defined JSON Schema.
 */
const validateIPAddress = async function (address) {
    let result = {
        type: null,
        address: null,
        valid: false
    }
    target.address = "";
    if (JSONValidators.IP4({ ip: address })) {
        result.type = 'ipv4';
        result.address = address;
    } else if (JSONValidators.IP6({ ip: address })) {
        result.type = 'ipv6';
        result.address = address;
    }
    if (result.address)
        result.valid = true;
    return result;
}


//Helper Functions
/**
 * The node module, uid, maintains an internal buffer up to 512 ids for the cryptographically insecure
 * version using Math.random, therefore there is a soft cap of of 512 print orders coming through the 
 * server at once before the possibility of collision can occur.
 * safeUID solves the uid node module 512 limit, 
 * and makes possibilities of id collisions near impossible by externally checking against an 
 * array of used values, and reruns it up to a default 512 times. 
 * The safeUID function accepts an array to check, and the length of the id 
 * uses the 'uid/single', variant of the uid module for speed, and instead 
 * maintains its own collision protection by matching the generated UID to values in a given 
 * array.
 * 
 * Either accepts a set variable uIDLength, or randomly chooses a number from 6 to 11 for 
 * the uIDLength.
 */
const safeUID = async function (outOf = [], _uIDLength, maxAttempts = 512) {
    let uIDLength = _uIDLength ?? (6 + Math.floor((Math.random() * 11)));

    let uniqueID = uid(uIDLength);
    if (outOf.includes(uniqueID))
        return uniqueID;

    for (let attempts = 0; attempts < maxAttempts; attempts++) {
        uniqueID = uid(uIDLength);
        if (!outOf.includes(uniqueID)) {
            uniqueID = uid(uIDLength);
            break;
        }
    }
    outOf.push(uniqueID);
    return uniqueID;
}

/**
 * Asynchronous function to check if file exists. DO NOT USE IN ENSURE FUNCTIONS.
 * DO NOT USE TO CHECK IF FILE EXISTS BEFORE WRITING TO IT. JUST HANDLE ERROR IF FILE DOES NOT
 * EXISTS.
 */
const fileExists = async function (filePath) {
    let success = false;
    try {
        await fs.promises.access(path.normalize(filePath), constants.F_OK);
        success = true;
        console.log('File: '.green, path.basename(filePath).green.bold, 'exists.'.green);
    } catch (error) {
        console.log('File: '.red, path.basename(filePath).red.bold, 'does not exist.'.red);
    } finally {
        return success;
    }
}

/**
 *  creates directory if doesn't exist and returns the path, and whether mkdir was needed; 
 */
const ensureDirectory = async function (_path, logFlag = false) {
    let existed = false;
    const directoryPath = path.normalize(_path.toString());

    try {
        await fs.promises.mkdir(directoryPath, {
            recursive: true
        });
    } catch (error) {
        if (error.code !== 'EEXIST') {
            throw error
            process.exit(1);
        }
        else {
            existed = true;
        }

    } finally {
        if (logFlag)
            console.log('Directory:'.green, `${path.basename(directoryPath)} `.green.bold,
                ((existed) ? 'was just created' : 'already existed ').green,
                'in:'.green, `${'./' + path.dirname(directoryPath)}`.green.bold, '\n');
        return {
            _path: directoryPath,
            existed: existed
        };
    }
};

/**
 * updates an array of available printers to avoid calling the ptp.getPrinters each time a post request is made.
 * Instead it checks whether the printer is available within the PRINTERS.available list, and is run
 * every ${UPDATE_AVAILABLE_PRINTERS_EVERY_MS}.
 */
const updatePrinters = async function () {
    try {
        PRINTERS.available = await ptp.getPrinters();
        if (!PRINTERS.any())
            throw new Error('No Printers available.');
    } catch (error) {
        console.log(error.message.toString().red, '\n');
    }
}

//Custom Middleware
/**
 * Simply Tags Requests with a collision resistant uniqueID.
 */
const tagPOSTRequests = async function (request, resolution, next) {
    if(request.method === 'POST')
        request.uniqueId = await safeUID(requestIDs, 10, 2048);
    next();
}
/**
 * Simple Middleware that uses compiled AVJ JSON Validator 
 * functions to quickly validate the incoming Print Requests.
*/
const validatePrintRequests = async function (request, resolution, next) {
    request.valid = JSONValidators.ALL(request?.body);
    if (request.valid) {
        let type = request.body.datatype
        request.valid = JSONValidators[type](request.body);
    }
    request.invalid = !request.valid;
    next();
}





//Set Intervals
const UPDATE_AVAILABLE_PRINTERS_EVERY_MS = 1000 * 60 * 15;
setInterval(updatePrinters, UPDATE_AVAILABLE_PRINTERS_EVERY_MS);


//Print functions.
/**
 * Uses ptp to print PDFs using passed in request.
 * request is tagged with printing.
 */
const printPDF = async function (request) {
    try {
        let content = Buffer.from(request.body.content, 'base64');
        const filePath = path.resolve(__dirname, `./storage/temp/${request.uniqueId}.pdf`);
        await fs.promises.writeFile(filePath, content);

        const options = {
            printer: request.body.printer
        };

        await ptp.print(filePath, options);
        request._result.success = true;
    } catch (error) { request._result.success = false }
    finally {
        const index = requestIDs.indexOf(request.uniqueId)
        requestIDs.splice(index, 1);
        try {
            await fs.promises.unlink(request.uniqueId);
            return;
        } catch (error) {
            if (error.code === 'ENOENT')
                return;
            else
                throw error;
        }
    }


}

const printZPL = async function (request) {
    //TODO
}





//Route Definitions

/**
 * Serves the Server Page.
 */
const onGet = async function (request, resolution) {
    try {
        resolution.json({
            success: true,
            msg: "Get Request..."
        });
    } catch (error) {
        console.log(`${error}`.red);
    }
}


const onPost = async function (request, resolution) {
    request._result = {
        success: false,
        message: ""
    }

    try {
        if (request.invalid)
            throw new Error(`Invalid Request according to AVJ Validation.`);

        if (!PRINTERS.any())
            throw new Error(`No Printers Available.`);

        if (!PRINTERS.isAvailable(request.body.printer))
            throw new Error(`Printer specified in request unavailable.`);

        if (request.body.datatype = "PDF")
            await printPDF(request);
        else if (request.body.datatype = "ZPL")
            await printZPL(request); //TODO

        if (!request._result.success)
            throw new Error(`Print '${request.body.datatype}' Process failed.`);
        

    } catch (error) {
        request._result.success = false;
        request._result.message = await step.errorHandler.exception(error);
    }
    finally {
        resolution.send(request._result);
    }
}





//step - just quick function defs for logging the start, success, and failing of a load step.
const step = {
    start: (str) => { console.log(str.yellow) },
    success: (str) => { console.log(`${str.green}\n`) },
    fail: (str) => { throw new Error(str) },
    errorHandler: {
        startup: async (error) => {
            console.log(error.message.toString().red, '\n');
            console.log('Server Startup Process failed...'.red.bold);
            process.exit(1)
        },
        exception: async (error) => {
            console.log(error.message.toString().red, '\n');
            return error.message;
        }
    }

};


const setupDirectoryStructure = async function () {
    step.start(`Running Directory Structure Setup for Print-Server...`);

    try {
        let temp = ensureDirectory('./storage/temp/files');
        let templates = ensureDirectory('./storage/persistent/templates');
        let printers = ensureDirectory('./storage/persistent/printers');
        let statics = ensureDirectory('./storage/static');
        await temp;
        await templates;
        await printers;
        await statics;
    } catch { step.fail('Directory Structure Setup Failed.') };

    step.success('Directory Structure Setup Completed.');
}

const setupPersistentStorage = async function () {
    step.start(`Running Persistent Storage Setup for Print-Server...`);

    try {

        const templates = storage.create({
            dir: './storage/persistent/templates',
            stringify: fastStringify,
            parse: JSON.parse,
            encoding: 'utf8',
            forgiveParseErrors: false,
            ttl: false
        });

        const printers = storage.create({
            dir: './storage/persistent/printers',
            stringify: fastStringify,
            parse: JSON.parse,
            encoding: 'utf8',
            forgiveParseErrors: false,
            ttl: false
        });

        await templates.init();
        await printers.init();

        persistent.templates = templates;
        persistent.printers = printers;
    } catch { step.fail('Persistent Storage Setup Failed.') }

    step.success('Persistent Storage Setup Completed.');
}

const compileJSONValidators = async function () {
    step.start('Compiling AVJ JSON Schema into Validators...');

    try {
        JSONValidators.init();
    }
    catch { step.fail('AVJ JSON Schemas failed to compile into Validators.') }

    step.success('AVJ JSON Schemas successfully compiled into Validators.');
}

const includeMiddleware = async function () {
    step.start('Including Middleware...');

    try {
        app.use(tagPOSTRequests);
        app.use(bodyParser.urlencoded({ extended: true }));
        app.use(validatePrintRequests);
    }
    catch { step.fail('Failed to include Middleware...') }

    step.success('Middleware successfully included.');
}

const defineRoutes = async function (middleware) {
    step.start('Defining Routes...'.yellow);

    try {
        app.get('/', onGet);
        app.post('/', onPost);
    } catch { step.fail('Failed to define Routes.') }

    step.success('Routes successfully defined.'.green);
}

const listen = async function () {
    step.start(`Attempting to listen on port: ${PORT.toString().bold}...`);

    try {
        app.listen(PORT);
    } catch { step.fail(`Server failed to listen on ${PORT.toString().bold}`) }

    step.success(`Server successfully listening on Port: ${PORT.toString().bold}`)
}


const run = async function () {
    try {
        step.start(`Running Startup Process for Wipfli Print-Server Version: ${SERVER_VERSION.toString().white.bold}\n`);

        await setupDirectoryStructure();

        await setupPersistentStorage();

        await compileJSONValidators();

        await includeMiddleware();

        await defineRoutes();

        await listen();

        step.success('Server Startup Process completed successfully.');
    } catch (error) {
        //Shuts down server if error is thrown up by step.fail();
        await step.errorHandler.startup(error);
    } finally {
        //SUCCESS. THROWING ERR: SENDS OUT process.exit(1); Closes program after logging error message to console.

    }
}

run();