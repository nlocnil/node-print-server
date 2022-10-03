import express from 'express';
import cors from 'cors';
import storage from 'node-persist';
import fastStringify from 'fast-stringify';
import ptp from 'pdf-to-printer';
import fs from 'fs';
import colors from 'colors';
import path from 'path';
import helmet from 'helmet';
import { uid } from 'uid/single';
import { title } from 'process';
import os, { platform } from 'os';
import bodyParser from 'body-parser';
import Ajv from "ajv";
import addFormats from "ajv-formats"
import find from 'local-devices' //To search local network.


/**
 * SEND TYPE
 * CUT:ZPL 
 * PDF:ASM: , FUCKING DUMBASS.
 */
const SERVER_VERSION = '0.0.8';
const PLATFORM_TO_SYSTEM = {
    'win32': 'WIN',
    'darwin': 'MAC',
    'linux': 'LNX',
    'WIN': 'Windows',
    'MAC': 'Mac',
    'LNX': 'Linux'
}
const SYSTEM = PLATFORM_TO_SYSTEM[os.platform];
const PORT = 3000;
const ajv = new Ajv();
addFormats(ajv);
const app = express();
const tempFileIDs = [];

//stores persistent storage.
const persistent = {
    templates: null,
    printers: null
}

/** 
 * Validators for the parsed POST.
 * ZPL for {'type':'ZPL'}, and PDF for {'type':'PDF'}
 * 
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
 * Accepts either ipv4 || ipv6 strings and determines whether or nit
 */
const validateIPAddress = function (address) {
    let result = {
        address: null,
        ipv4: null,
        ipv6: null,
        valid: false
    }
    target.address = "";
    if (JSONValidators.IP4({ip: address})) {
        result.address = 'ipv4';
        result.ipv4 = address;
    } else if (JSONValidators.IP6({ip: address})) {
        result.address = 'ipv6';
        result.ipv6 = address;
    }
    if (result.address)
        result.valid = true;
    return result;
}





/**
 * The node module, uid, maintains an internal buffer up to 512 ids for the cryptographically insecure
 * version using Math.random, therefore there is a soft cap of of 512 print orders coming through the 
 * server at once before the possibility of collision can occur.
*/

/**
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
 * creates directory if doesn't exist and returns the path, and whether mkdir was needed; 
 * @param {string} path - path to directory.
 * @param {boolean} logFlag - whether to log results of function towards console. 
 * Relies on colors for nicer logging, and path for validation of directory paths.
 * @returns {object} 
 * {path: string
 *  existed: boolean 
 * }
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
 * Makes sure that server folder structure is properly setup, and that all folders exists.
 */
const setupDirectoryStructure = async function () {
    try {
        console.log(`Running Directory Structure Setup for Print-Server...`.yellow);
        let temp = ensureDirectory('./storage/temp/files');
        let templates = ensureDirectory('./storage/persistent/templates');
        let printers = ensureDirectory('./storage/persistent/printers');
        let serverpage = ensureDirectory('./static/serverpage');
        await temp;
        await templates;
        await printers;
        await serverpage;
    } catch (error) {
        console.log('Directory Structure Setup Failed.'.red, '\n');
        throw error
    }
    console.log('Directory Structure Setup Completed.'.green, '\n');
    return;
}

const setupPersistentStorage = async function () {
    console.log(`Running Persistent Storage Setup for Print-Server...`.yellow);
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
    } catch (error) {
        console.log('Persistent Storage Setup Failed.'.red, '\n');
        throw error
    }
    console.log('Persistent Storage Setup Completed.'.green, '\n');
}


const onStartup = async function () {
    await setupDirectoryStructure();
    await setupPersistentStorage();

    console.log('Storage Setup Completed.'.green,'\n');
    return;
}


const onListen = async function () {
    try {
        console.log(`Wipfli Print-Server Version: ${SERVER_VERSION.white.bold} `.yellow + `now listening on port:`.yellow, `${PORT}`.white.bold, '\n');



    } catch (error) {
        throw error
    }
}

const getStatic = async function (file) {
    return;
}

const onGet = async function (request, resolution) {
    try {
        resolution.set('Content-Type', 'text/html')
        resolution.sendFile(path.resolve(path.join(path.dirname('storage'), '/page/index.html')));

    } catch (e) {
        console.log(e);
    }

}
/**
 * Simple Middleware that uses compiled AVJ JSON Validator 
 * functions to quickly validate the incoming Print Requests.
*/
const validateRequests = async function (request, resolution, next) {
    request.valid = JSONValidators.ALL(request?.body);
    if (request.valid) {
        let type = request.body.datatype
        request.valid = JSONValidators[type](request.body);
    }
    request.invalid = !request.valid;
    next();
}
/**
 * Accepts 
 * IP || deviceID for Printer
 * type: PDF || ZPL
 * ZPL: {variables}
 * content: 
 */
const onPost = async function (request, resolution) {
    let status = {
        success: false,
        message: ""
    }
    try {
        //does an initial validation.
        if (request.invalid)
            throw new Error(`Invalid Request according to AVJ Validation.`);
        

    } catch (error) {
        console.log(error.message.red);
        status.message = error.message;
        
    } finally {
        resolution.send(status);
    }
}

const printPDF = async function (pdf) {
    
};


const PrintRequest = {

    onFail: async function (req, res) {
    
    },

     onSuccess: async function (req, res) {

    }
}

const launch = async function () {
    console.log(`Launching Wipfli Print-Server Version ${SERVER_VERSION.white.bold}`.yellow ,'for:'.yellow, PLATFORM_TO_SYSTEM[SYSTEM].white.bold, '\n');
    onStartup()
        .then(() => {
            console.log('Compiling AVJ JSON Schema into Validators...'.yellow);
            try {
                JSONValidators.init();
                console.log('AVJ JSON Schemas successfully compiled into Validators.'.green);
            } catch (error) {
                console.log('AVJ JSON Schemas failed to compile into Validators...'.red);
                throw error;
            } finally {
                console.log('');
            }
        })
        .then(() => {
            try {
                console.log('Including Middleware...'.yellow)
                app.use(cors());
                app.use(helmet());
                app.use(bodyParser.urlencoded({ extended: true }))
                app.use(validateRequests);
                console.log('Middleware successfully included...'.green);
            } catch (error) {
                console.log('Failed to include Middleware...'.red);
                throw error;
            } finally {
                console.log('');
            }
        })
        .then(() => {
            try {
                console.log('Defining Routes...'.yellow);
                //DEFINE ROUTES HERE
                app.get('/', onGet);
                app.post('/', onPost);
                console.log('Routes successfully defined.'.green);
            } catch (error) {
                console.log('Failed to define Routes.'.red);
                throw error;
            } finally {
                console.log('');
            }
        })
        .then(() => {
            console.log('Server Startup Process completed successfully.'.green.bold, '\n');
            app.listen(3000, onListen);
        })
        .catch(function (error) {
            console.log('Server Startup Process failed...'.red.bold, '\n');
            console.log('ERROR: '.red, `${error}`.red.bold);
            process.exit(1);
        });
};


launch();