import got, { Options as GotOptions, RequestError } from 'got';
import _ from 'lodash';
import path from 'path';
import decompress from 'decompress';
import {
  DollieError,
  HTTPNotFoundError,
  HTTPTimeoutError,
} from './errors';
import Url from 'url';
import tunnel from 'tunnel';
import fs from 'fs';
import {
  VIRTUAL_VOLUME_DESTINATION_PATHNAME,
} from './constants';
import { FileSystem, LoaderConfig, ReadTemplateCallbackData } from './interfaces';
import { isBinaryFileSync } from 'isbinaryfile';

const downloadCompressedFile = async (
  url: string,
  fileSystem: FileSystem,
  options: GotOptions = {},
) => {
  const startTimestamp = Date.now();

  return new Promise((resolve, reject) => {
    fileSystem.mkdirSync(VIRTUAL_VOLUME_DESTINATION_PATHNAME, { recursive: true });

    const getAbsolutePath = (filePath) => {
      const relativePathname = filePath.split('/').slice(1).join('/');
      return path.resolve(VIRTUAL_VOLUME_DESTINATION_PATHNAME, relativePathname);
    };

    const downloaderOptions = _.merge(options || {}, { isStream: true });

    const downloader = got.stream(
      url,
      downloaderOptions as GotOptions & { isStream: true },
    );

    const fileBufferChunks = [];

    downloader.on('error', (error: RequestError) => {
      const errorMessage = error.toString();
      if (errorMessage.indexOf('404') !== -1) {
        reject(new HTTPNotFoundError());
      }
      if (error.code === 'ETIMEDOUT') {
        reject(new HTTPTimeoutError());
      }
      const otherError = new DollieError(errorMessage);
      otherError.code = error.code || 'E_UNKNOWN';
      reject(new Error(errorMessage));
    });

    downloader.on('data', (chunk) => {
      fileBufferChunks.push(chunk);
    });

    downloader.on('end', () => {
      const fileBuffer = Buffer.concat(fileBufferChunks);

      decompress(fileBuffer).then((files) => {
        for (const file of files) {
          const { type, path: filePath, data } = file;
          if (type === 'directory') {
            fileSystem.mkdirSync(getAbsolutePath(filePath), { recursive: true });
          } else if (type === 'file') {
            fileSystem.writeFileSync(getAbsolutePath(filePath), data, { encoding: 'utf8' });
          }
        }
        return;
      }).then(() => {
        resolve(Date.now() - startTimestamp);
      });
    });
  });
};

const loadTemplate = async (
  url: string,
  fileSystem: FileSystem = fs,
  options: LoaderConfig = {},
) => {
  const traverse = async function(
    url: string,
    fileSystem: FileSystem = fs,
    retries = 0,
    options: LoaderConfig = {},
  ) {
    const {
      httpProxyUrl = '',
      httpProxyAuth = '',
      maximumRetryCount = 3,
      ...originalOptions
    } = options;
    const gotOptions = _.clone(originalOptions) as GotOptions;
    if (httpProxyUrl) {
      const { hostname: host, port } = Url.parse(httpProxyUrl);
      const proxy: tunnel.ProxyOptions = {
        host,
        port: parseInt(port, 10),
      };
      if (httpProxyAuth) { proxy.proxyAuth = httpProxyAuth; }
      gotOptions.agent = {
        http: tunnel.httpOverHttp({ proxy }),
        https: tunnel.httpsOverHttp({ proxy }),
      };
    }
    try {
      return await downloadCompressedFile(
        url,
        fileSystem,
        gotOptions,
      );
    } catch (error) {
      if (error.code === 'E_TEMPLATE_TIMEOUT' || error instanceof HTTPTimeoutError) {
        if (retries < maximumRetryCount) {
          return await traverse(
            url,
            fileSystem,
            retries + 1,
            options,
          );
        } else {
          throw new Error(error?.message || 'download template timed out');
        }
      } else {
        throw error;
      }
    }
  };
  return await traverse(url, fileSystem, 0, options);
};

const readTemplateContent = (
  fileSystem: FileSystem = fs,
  pathname = VIRTUAL_VOLUME_DESTINATION_PATHNAME,
) => {
  const result: ReadTemplateCallbackData[] = [];

  const traverse = async (fileSystem: FileSystem = fs, currentEntityPathname: string) => {
    if (fileSystem.existsSync(currentEntityPathname)) {
      const stat = fileSystem.statSync(currentEntityPathname);
      const fileContent = stat.isFile()
        ? fileSystem.readFileSync(currentEntityPathname, 'binary')
        : null;

      result.push({
        absolutePathname: currentEntityPathname,
        relativePathname: path.relative(pathname, currentEntityPathname),
        entityName: currentEntityPathname.split('/').pop(),
        isBinary: (stat.isFile() && fileContent)
          ? isBinaryFileSync(fileContent, fileContent.length)
          : false,
        isDirectory: stat.isDirectory(),
      });

      if (stat.isDirectory()) {
        const entities = fileSystem.readdirSync(currentEntityPathname);
        for (const entity of entities) {
          traverse(fileSystem, `${currentEntityPathname}/${entity}`);
        }
      }
    }
  };

  traverse(fileSystem, pathname);

  return result;
};

export {
  downloadCompressedFile,
  loadTemplate,
  readTemplateContent,
};
