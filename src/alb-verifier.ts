import { AwsAlbJwksCache } from "./alb";
import { assertStringArrayContainsString } from "./assert";
import { JwtInvalidClaimError, JwtInvalidSignatureAlgorithmError, ParameterValidationError } from "./error";
import { Jwks, JwksCache } from "./jwk";
import { DecomposedJwt, decomposeUnverifiedJwt } from "./jwt";
import { JwtHeader, JwtPayload } from "./jwt-model";
import { verifyDecomposedJwt, verifyDecomposedJwtSync } from "./jwt-verifier";
import { JsonObject } from "./safe-json-parse";
import { Properties } from "./typing-util";

type LoadBalancerArn = string;

export const supportedSignatureAlgorithms = [
  "ES256",
] as const;

export class AlbJwtInvalidSignerError extends JwtInvalidClaimError {}
export class AlbJwtInvalidClientIdError extends JwtInvalidClaimError {}

export interface AlbVerifyProperties {

    /**
     * The client ID that you expect to be present on the JWT
     * (In the ID token's aud claim, or the Access token's client_id claim).
     * If you provide a string array, that means at least one of those client IDs
     * must be present on the JWT.
     * Pass null explicitly to not check the JWT's client ID--if you know what you're doing
     */
    clientId: string | string[] | null;

    loadBalancerArn: string;

    jwksUri?: string;
    issuer: string;

    /**
     * If you want to peek inside the invalid JWT when verification fails, set `includeRawJwtInErrors` to true.
     * Then, if an error is thrown during verification of the invalid JWT (e.g. the JWT is invalid because it is expired),
     * the Error object will include a property `rawJwt`, with the raw decoded contents of the **invalid** JWT.
     * The `rawJwt` will only be included in the Error object, if the JWT's signature can at least be verified.
     */
    includeRawJwtInErrors?: boolean;
  
}

/** Type for ALB JWT verifier properties, for a single ALB */
export type AlbJwtVerifierProperties = {

  loadBalancerArn: string;
  
} & Partial<AlbVerifyProperties>;

/**
 * Type for ALB JWT verifier properties, when multiple ALB are used in the verifier.
 */
export type AlbJwtVerifierMultiProperties = {

  loadBalancerArn: string;

} & AlbVerifyProperties;

export type AlbDataVerifierSingleAlb<
T extends AlbJwtVerifierProperties,
> = AlbDataVerifier<
  Properties<AlbVerifyProperties, T>,
  false
>;

export type AlbDataVerifierMultiAlb<
T extends AlbJwtVerifierProperties,
> = AlbDataVerifier<
  Properties<AlbVerifyProperties, T>,
  true
>;

type AlbVerifyParameters<SpecificVerifyProperties> = {
  [key: string]: never;
} extends SpecificVerifyProperties
  ? [jwt: string, props?: SpecificVerifyProperties]
  : [jwt: string, props: SpecificVerifyProperties];
  
export type AlbConfig = {
  
  loadBalancerArn: string;
  defaultJwksUri: string;//Managing multi region ALB even if not possible (ALB target group are single region)

} & Partial<AlbJwtVerifierProperties>;

type DataTokenPayload = {
  exp:number
  iss:string,
} & JsonObject;

export class AlbDataVerifier<
  SpecificVerifyProperties extends Partial<AlbVerifyProperties>,
  MultiAlb extends boolean,
> {

  readonly albConfigMap: Map<LoadBalancerArn, AlbConfig> = new Map();
  // private readonly publicKeyCache = new KeyObjectCache();
  readonly jwksCache: JwksCache = new AwsAlbJwksCache();

  private constructor(
      props: AlbJwtVerifierProperties | AlbJwtVerifierMultiProperties[],
    ) {
      if(Array.isArray(props)){
        if (!props.length) {
          throw new ParameterValidationError(
            "Provide at least one alb configuration"
          );
        }
        for (const albProps of props) {
          if (this.albConfigMap.has(albProps.loadBalancerArn)) {
            throw new ParameterValidationError(
              `loadBalancerArn ${albProps.loadBalancerArn} supplied multiple times`
            );
          }
          this.albConfigMap.set(albProps.loadBalancerArn, {
            ...albProps,
            defaultJwksUri: this.defaultJwksUri(albProps),
          });
        }
      }else {
        this.albConfigMap.set(props.loadBalancerArn,  {
          ...props,
          defaultJwksUri: this.defaultJwksUri(props),
        });
      }
    }

  private extractRegionFromLoadBalancerArn(loadBalancerArn: string): string {
    const arnParts = loadBalancerArn.split(":");
    if (arnParts.length < 4) {
      throw new ParameterValidationError(`Invalid load balancer ARN: ${loadBalancerArn}`);
    }
    return arnParts[3];
  }

  private defaultJwksUri(params:{loadBalancerArn: string}): string {
    const region = this.extractRegionFromLoadBalancerArn(params.loadBalancerArn);
    return `https://public-keys.auth.elb.${region}.amazonaws.com`;
  }

  static create<T extends AlbJwtVerifierProperties>(
    verifyProperties: T & Partial<AlbJwtVerifierProperties>
  ): AlbDataVerifierSingleAlb<T>;


  static create<T extends AlbJwtVerifierMultiProperties>(
    props: (T & Partial<AlbJwtVerifierMultiProperties>)[]
  ): AlbDataVerifierMultiAlb<T>;

  static create(
    verifyProperties:
      | AlbJwtVerifierProperties
      | AlbJwtVerifierMultiProperties[]
  ) {
    return new this(verifyProperties);
  }
 
  public async verify(
    ...[jwt, properties]: AlbVerifyParameters<SpecificVerifyProperties>): Promise<DataTokenPayload>{
    const { decomposedJwt, jwksUri, verifyProperties } = this.getVerifyParameters(jwt, properties);
    await this.verifyDecomposedJwt(decomposedJwt, jwksUri, verifyProperties);
    try {
      this.validateDataJwtFields(decomposedJwt.header, verifyProperties);
    } catch (err) {
      if (
        verifyProperties.includeRawJwtInErrors &&
        err instanceof JwtInvalidClaimError
      ) {
        throw err.withRawJwt(decomposedJwt);
      }
      throw err;
    }
    return decomposedJwt.payload as DataTokenPayload;
  }

  public verifySync( ...[jwt, properties]: AlbVerifyParameters<SpecificVerifyProperties>): DataTokenPayload {
    const { decomposedJwt, jwksUri, verifyProperties } = this.getVerifyParameters(jwt, properties);
    this.verifyDecomposedJwtSync(decomposedJwt, jwksUri, verifyProperties);
    try {
      this.validateDataJwtFields(decomposedJwt.header, verifyProperties);
    } catch (err) {
      if (
        verifyProperties.includeRawJwtInErrors &&
        err instanceof JwtInvalidClaimError
      ) {
        throw err.withRawJwt(decomposedJwt);
      }
      throw err;
    }
    return decomposedJwt.payload as DataTokenPayload;
  }

  protected getVerifyParameters(
      jwt: string,
      verifyProperties?: Partial<AlbJwtVerifierProperties>
    ): {
      decomposedJwt: DecomposedJwt;
      jwksUri: string,
      verifyProperties: AlbJwtVerifierProperties;
    } {
      const decomposedJwt = decomposeUnverifiedJwt(jwt);
      assertStringArrayContainsString(
        "Signer",
        decomposedJwt.header.signer,
        this.expectedLoadBalancerArn,
        AlbJwtInvalidSignerError
      );
      const albConfig = this.getAlbConfig(decomposedJwt.header.signer);
      return {
        decomposedJwt,
        jwksUri: verifyProperties?.jwksUri ?? albConfig.defaultJwksUri,
        verifyProperties: {
          ...albConfig,
          ...verifyProperties,
        } as unknown as AlbJwtVerifierProperties,
      };
  }

  private validateDataJwtFields(
    header:JwtHeader,
    options: {
      loadBalancerArn: string;
      issuer?: string;
      clientId?: string | string[] | null;
    }
  ): void {

    // Check JWT signature algorithm is one of the supported signature algorithms
    assertStringArrayContainsString(
      "JWT signature algorithm",
      header.alg,
      supportedSignatureAlgorithms,
      JwtInvalidSignatureAlgorithmError
    );
    
    // Check client ID header
    if (options.clientId !== null) {
      if (options.clientId === undefined) {
        throw new ParameterValidationError(
          "clientId must be provided or set to null explicitly"
        );
      }
      assertStringArrayContainsString(
        "Client ID",
        header.client,
        options.clientId,
        AlbJwtInvalidClientIdError
      );
    }
  }
  
  public cacheJwks(
    ...[jwks, loadBalancerArn]: MultiAlb extends false
      ? [jwks: Jwks, loadBalancerArn?: string]
      : [jwks: Jwks, loadBalancerArn: string]
  ): void {
    const albConfig = this.getAlbConfig(loadBalancerArn);
    this.jwksCache.addJwks(albConfig.jwksUri ?? albConfig.defaultJwksUri, jwks);
    // this.publicKeyCache.clearCache(albConfig.loadBalancerArn);
  }

  protected getAlbConfig(
      loadBalancerArn?: string
    ): AlbConfig {
    if (!loadBalancerArn) {
      if (this.albConfigMap.size !== 1) {
        throw new ParameterValidationError("loadBalancerArn must be provided");
      }
      loadBalancerArn = this.albConfigMap.keys().next().value;
    }
    const config = this.albConfigMap.get(loadBalancerArn!);
    if (!config) {
      throw new ParameterValidationError(`loadBalancerArn not configured: ${loadBalancerArn}`);
    }
    return config;
  }
  
  protected get expectedLoadBalancerArn(): string[] {
    return Array.from(this.albConfigMap.keys());
  }

  protected verifyDecomposedJwt(
    decomposedJwt: DecomposedJwt,
    jwksUri: string,
    verifyProperties: AlbJwtVerifierProperties
  ): Promise<JwtPayload> {
    return verifyDecomposedJwt(
      decomposedJwt,
      jwksUri,
      {
        includeRawJwtInErrors: verifyProperties.includeRawJwtInErrors,
        issuer: verifyProperties.issuer,
        audience:null
      },
      this.jwksCache.getJwk.bind(this.jwksCache),
      // (jwk, alg, _issuer) => {
      //   // Use the load balancer ARN instead of the issuer for the public key cache
      //   const loadBalancerArn = decomposedJwt.header.signer as string;
      //   return this.publicKeyCache.transformJwkToKeyObjectAsync(jwk, alg, loadBalancerArn);
      // }
    );
  }

  protected verifyDecomposedJwtSync(
    decomposedJwt: DecomposedJwt,
    jwksUri: string,
    verifyProperties: AlbJwtVerifierProperties
  ): JwtPayload {
    const jwk = this.jwksCache.getCachedJwk(jwksUri, decomposedJwt);
    return verifyDecomposedJwtSync(
      decomposedJwt,
      jwk,
      {
        includeRawJwtInErrors: verifyProperties.includeRawJwtInErrors,
        issuer: verifyProperties.issuer,
        audience:null
      },
      // (jwk, alg, _issuer) => {
      //   // Use the load balancer ARN instead of the issuer for the public key cache
      //   const loadBalancerArn = decomposedJwt.header.signer as string;
      //   return this.publicKeyCache.transformJwkToKeyObjectSync(jwk, alg, loadBalancerArn);
      // }
    );
  }
}