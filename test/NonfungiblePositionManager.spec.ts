import { BigNumberish, constants, Contract } from 'ethers'
import { waffle, ethers } from 'hardhat'

import { Fixture } from 'ethereum-waffle'
import {
  TestPositionNFTOwner,
  MockTimeNonfungiblePositionManager,
  TestERC20,
  IWETH10,
  IWETH9,
  IUniswapV3Factory,
} from '../typechain'
import completeFixture from './shared/completeFixture'
import { computePoolAddress } from './shared/computePoolAddress'
import { FeeAmount, MaxUint128, TICK_SPACINGS } from './shared/constants'
import { encodePriceSqrt } from './shared/encodePriceSqrt'
import { expect } from './shared/expect'
import getPermitNFTSignature from './shared/getPermitNFTSignature'
import poolAtAddress from './shared/poolAtAddress'
import snapshotGasCost from './shared/snapshotGasCost'
import { getMaxTick, getMinTick } from './shared/ticks'
import { expandTo18Decimals } from './shared/expandTo18Decimals'
import { sortedTokens } from './shared/tokenSort'

describe('NonfungiblePositionManager', () => {
  const wallets = waffle.provider.getWallets()
  const [wallet, other] = wallets

  const nftFixture: Fixture<{
    nft: MockTimeNonfungiblePositionManager
    factory: IUniswapV3Factory
    tokens: [TestERC20, TestERC20, TestERC20]
    weth9: IWETH9
    weth10: IWETH10
  }> = async (wallets, provider) => {
    const { weth9, weth10, factory, tokens, nft } = await completeFixture(wallets, provider)

    // approve & fund wallets
    for (const token of tokens) {
      await token.approve(nft.address, constants.MaxUint256)
      await token.connect(other).approve(nft.address, constants.MaxUint256)
      await token.transfer(other.address, expandTo18Decimals(1_000_000))
    }

    return {
      nft,
      factory,
      tokens,
      weth9,
      weth10,
    }
  }

  let factory: IUniswapV3Factory
  let nft: MockTimeNonfungiblePositionManager
  let tokens: [TestERC20, TestERC20, TestERC20]
  let weth9: IWETH9
  let weth10: IWETH10

  let loadFixture: ReturnType<typeof waffle.createFixtureLoader>

  before('create fixture loader', async () => {
    loadFixture = waffle.createFixtureLoader(wallets)
  })

  beforeEach('load fixture', async () => {
    ;({ nft, factory, tokens, weth9, weth10 } = await loadFixture(nftFixture))
  })

  it('bytecode size', async () => {
    expect(((await nft.provider.getCode(nft.address)).length - 2) / 2).to.matchSnapshot()
  })

  describe('#firstMint', () => {
    it('creates the pool at the expected address', async () => {
      const expectedAddress = computePoolAddress(
        factory.address,
        [tokens[0].address, tokens[1].address],
        FeeAmount.MEDIUM
      )
      const code = await wallet.provider.getCode(expectedAddress)
      expect(code).to.eq('0x')
      await nft.firstMint({
        token0: tokens[0].address,
        token1: tokens[1].address,
        sqrtPriceX96: encodePriceSqrt(1, 1),
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        recipient: wallet.address,
        amount: 10,
        deadline: 1,
        fee: FeeAmount.MEDIUM,
      })
      const codeAfter = await wallet.provider.getCode(expectedAddress)
      expect(codeAfter).to.not.eq('0x')
    })

    it('works if pool is created but not initialized', async () => {
      const expectedAddress = computePoolAddress(
        factory.address,
        [tokens[0].address, tokens[1].address],
        FeeAmount.MEDIUM
      )
      await factory.createPool(tokens[0].address, tokens[1].address, FeeAmount.MEDIUM)
      const code = await wallet.provider.getCode(expectedAddress)
      expect(code).to.not.eq('0x')
      await nft.firstMint({
        token0: tokens[0].address,
        token1: tokens[1].address,
        sqrtPriceX96: encodePriceSqrt(2, 1),
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        recipient: wallet.address,
        amount: 10,
        deadline: 1,
        fee: FeeAmount.MEDIUM,
      })
    })

    it('creates a token', async () => {
      await nft.firstMint({
        token0: tokens[0].address,
        token1: tokens[1].address,
        sqrtPriceX96: encodePriceSqrt(1, 1),
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        recipient: other.address,
        amount: 10,
        deadline: 1,
        fee: FeeAmount.MEDIUM,
      })
      expect(await nft.balanceOf(other.address)).to.eq(1)
      expect(await nft.tokenOfOwnerByIndex(other.address, 0)).to.eq(1)
      const {
        fee,
        token0,
        token1,
        tickLower,
        tickUpper,
        liquidity,
        tokensOwed0,
        tokensOwed1,
        feeGrowthInside0LastX128,
        feeGrowthInside1LastX128,
      } = await nft.positions(1)
      expect(token0).to.eq(tokens[0].address)
      expect(token1).to.eq(tokens[1].address)
      expect(fee).to.eq(FeeAmount.MEDIUM)
      expect(tickLower).to.eq(getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]))
      expect(tickUpper).to.eq(getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]))
      expect(liquidity).to.eq(10)
      expect(tokensOwed0).to.eq(0)
      expect(tokensOwed1).to.eq(0)
      expect(feeGrowthInside0LastX128).to.eq(0)
      expect(feeGrowthInside1LastX128).to.eq(0)
    })

    it('can use eth via multicall', async () => {
      const [token0, token1] = sortedTokens(weth9, tokens[0])

      const firstMintData = nft.interface.encodeFunctionData('firstMint', [
        {
          token0: token0.address,
          token1: token1.address,
          sqrtPriceX96: encodePriceSqrt(1, 1),
          tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          recipient: other.address,
          amount: 10,
          deadline: 1,
          fee: FeeAmount.MEDIUM,
        },
      ])

      const unwrapWETH9Data = nft.interface.encodeFunctionData('unwrapWETH9', [0, other.address])

      await nft.multicall([firstMintData, unwrapWETH9Data], { value: expandTo18Decimals(1) })
    })

    it('fails if past deadline', async () => {
      await nft.setTime(2)
      await expect(
        nft.firstMint({
          token0: tokens[0].address,
          token1: tokens[1].address,
          sqrtPriceX96: encodePriceSqrt(1, 1),
          tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          recipient: other.address,
          amount: 10,
          deadline: 1,
          fee: FeeAmount.MEDIUM,
        })
      ).to.be.revertedWith('Transaction too old')
    })

    it('fails if pool already exists', async () => {
      const params = {
        token0: tokens[0].address,
        token1: tokens[1].address,
        sqrtPriceX96: encodePriceSqrt(1, 1),
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        recipient: wallet.address,
        amount: 10,
        deadline: 1,
        fee: FeeAmount.MEDIUM,
      }
      await nft.firstMint(params)

      await expect(nft.firstMint(params)).to.be.reverted
    })

    it('fails if cannot transfer', async () => {
      await tokens[0].approve(nft.address, 0)
      await expect(
        nft.firstMint({
          token0: tokens[0].address,
          token1: tokens[1].address,
          sqrtPriceX96: encodePriceSqrt(1, 1),
          tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          recipient: wallet.address,
          amount: 10,
          deadline: 1,
          fee: FeeAmount.MEDIUM,
        })
      ).to.be.revertedWith('STF')
    })

    it('gas', async () => {
      await snapshotGasCost(
        nft.firstMint({
          token0: tokens[0].address,
          token1: tokens[1].address,
          sqrtPriceX96: encodePriceSqrt(1, 1),
          tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          recipient: wallet.address,
          amount: 10,
          deadline: 1,
          fee: FeeAmount.MEDIUM,
        })
      )
    })
  })

  describe('#mint', () => {
    it('fails if pool does not exist', async () => {
      await expect(
        nft.mint({
          token0: tokens[0].address,
          token1: tokens[1].address,
          tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          amount0Max: constants.MaxUint256,
          amount1Max: constants.MaxUint256,
          recipient: wallet.address,
          amount: 10,
          deadline: 1,
          fee: FeeAmount.MEDIUM,
        })
      ).to.be.reverted
    })

    it('creates a token', async () => {
      await nft.firstMint({
        token0: tokens[0].address,
        token1: tokens[1].address,
        sqrtPriceX96: encodePriceSqrt(1, 1),
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        recipient: other.address,
        amount: 10,
        deadline: 1,
        fee: FeeAmount.MEDIUM,
      })

      await nft.mint({
        token0: tokens[0].address,
        token1: tokens[1].address,
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        recipient: other.address,
        amount0Max: constants.MaxUint256,
        amount1Max: constants.MaxUint256,
        amount: 15,
        deadline: 10,
        fee: FeeAmount.MEDIUM,
      })
      expect(await nft.balanceOf(other.address)).to.eq(2)
      expect(await nft.tokenOfOwnerByIndex(other.address, 1)).to.eq(2)
      const {
        fee,
        token0,
        token1,
        tickLower,
        tickUpper,
        liquidity,
        tokensOwed0,
        tokensOwed1,
        feeGrowthInside0LastX128,
        feeGrowthInside1LastX128,
      } = await nft.positions(2)
      expect(token0).to.eq(tokens[0].address)
      expect(token1).to.eq(tokens[1].address)
      expect(fee).to.eq(FeeAmount.MEDIUM)
      expect(tickLower).to.eq(getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]))
      expect(tickUpper).to.eq(getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]))
      expect(liquidity).to.eq(15)
      expect(tokensOwed0).to.eq(0)
      expect(tokensOwed1).to.eq(0)
      expect(feeGrowthInside0LastX128).to.eq(0)
      expect(feeGrowthInside1LastX128).to.eq(0)
    })

    it('can use eth via multicall', async () => {
      const [token0, token1] = sortedTokens(weth9, tokens[0])

      await weth9.deposit({ value: expandTo18Decimals(1) })
      await weth9.approve(nft.address, constants.MaxUint256)

      await nft.firstMint({
        token0: token0.address,
        token1: token1.address,
        sqrtPriceX96: encodePriceSqrt(1, 1),
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        recipient: other.address,
        amount: 10,
        deadline: 1,
        fee: FeeAmount.MEDIUM,
      })

      await weth9.approve(nft.address, 0)

      const mintData = nft.interface.encodeFunctionData('mint', [
        {
          token0: token0.address,
          token1: token1.address,
          tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          recipient: other.address,
          amount: 10,
          deadline: 1,
          fee: FeeAmount.MEDIUM,
          amount0Max: constants.MaxUint256,
          amount1Max: constants.MaxUint256,
        },
      ])

      const unwrapWETH9Data = nft.interface.encodeFunctionData('unwrapWETH9', [0, other.address])

      await nft.multicall([mintData, unwrapWETH9Data], { value: expandTo18Decimals(1) })
    })

    it('gas ticks already used', async () => {
      await nft.firstMint({
        token0: tokens[0].address,
        token1: tokens[1].address,
        sqrtPriceX96: encodePriceSqrt(1, 1),
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        recipient: other.address,
        amount: 10,
        deadline: 1,
        fee: FeeAmount.MEDIUM,
      })

      await snapshotGasCost(
        nft.mint({
          token0: tokens[0].address,
          token1: tokens[1].address,
          tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          recipient: other.address,
          amount0Max: constants.MaxUint256,
          amount1Max: constants.MaxUint256,
          amount: 15,
          deadline: 10,
          fee: FeeAmount.MEDIUM,
        })
      )
    })

    it('gas first mint for ticks', async () => {
      await nft.firstMint({
        token0: tokens[0].address,
        token1: tokens[1].address,
        sqrtPriceX96: encodePriceSqrt(1, 1),
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        recipient: other.address,
        amount: 10,
        deadline: 1,
        fee: FeeAmount.MEDIUM,
      })

      await snapshotGasCost(
        nft.mint({
          token0: tokens[0].address,
          token1: tokens[1].address,
          tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]) + TICK_SPACINGS[FeeAmount.MEDIUM],
          tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]) - TICK_SPACINGS[FeeAmount.MEDIUM],
          recipient: other.address,
          amount0Max: constants.MaxUint256,
          amount1Max: constants.MaxUint256,
          amount: 15,
          deadline: 10,
          fee: FeeAmount.MEDIUM,
        })
      )
    })
  })

  describe('#increaseLiquidity', () => {
    const tokenId = 1
    beforeEach('create a position', async () => {
      await nft.firstMint({
        token0: tokens[0].address,
        token1: tokens[1].address,
        sqrtPriceX96: encodePriceSqrt(1, 1),
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        recipient: other.address,
        amount: 100,
        deadline: 1,
        fee: FeeAmount.MEDIUM,
      })
    })

    it('increases position liquidity', async () => {
      await nft.increaseLiquidity(tokenId, 150, constants.MaxUint256, constants.MaxUint256, 1)
      const { liquidity } = await nft.positions(tokenId)
      expect(liquidity).to.eq(250)
    })

    it('can be paid with ETH', async () => {
      const [token0, token1] = sortedTokens(tokens[0], weth9)

      const tokenId = 2
      const firstMintData = nft.interface.encodeFunctionData('firstMint', [
        {
          token0: token0.address,
          token1: token1.address,
          sqrtPriceX96: encodePriceSqrt(1, 1),
          tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          recipient: other.address,
          amount: 100,
          deadline: 1,
          fee: FeeAmount.MEDIUM,
        },
      ])
      const refundETHData = nft.interface.encodeFunctionData('unwrapWETH9', [0, other.address])
      await nft.multicall([firstMintData, refundETHData], { value: expandTo18Decimals(1) })

      const increaseLiquidityData = nft.interface.encodeFunctionData('increaseLiquidity', [
        tokenId,
        150,
        constants.MaxUint256,
        constants.MaxUint256,
        1,
      ])
      await nft.multicall([increaseLiquidityData, refundETHData], { value: expandTo18Decimals(1) })
    })

    it('gas', async () => {
      await snapshotGasCost(nft.increaseLiquidity(tokenId, 150, constants.MaxUint256, constants.MaxUint256, 1))
    })
  })

  describe('#decreaseLiquidity', () => {
    const tokenId = 1
    beforeEach('create a position', async () => {
      await nft.firstMint({
        token0: tokens[0].address,
        token1: tokens[1].address,
        sqrtPriceX96: encodePriceSqrt(1, 1),
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        recipient: other.address,
        amount: 100,
        deadline: 1,
        fee: FeeAmount.MEDIUM,
      })
    })

    it('fails if past deadline', async () => {
      await nft.setTime(2)
      await expect(nft.connect(other).decreaseLiquidity(tokenId, 50, 0, 0, 1)).to.be.revertedWith('Transaction too old')
    })

    it('cannot be called by other addresses', async () => {
      await expect(nft.decreaseLiquidity(tokenId, 50, 0, 0, 1)).to.be.revertedWith('Not approved')
    })

    it('decreases position liquidity', async () => {
      await nft.connect(other).decreaseLiquidity(tokenId, 25, 0, 0, 1)
      const { liquidity } = await nft.positions(tokenId)
      expect(liquidity).to.eq(75)
    })

    it('accounts for tokens owed', async () => {
      await nft.connect(other).decreaseLiquidity(tokenId, 25, 0, 0, 1)
      const { tokensOwed0, tokensOwed1 } = await nft.positions(tokenId)
      expect(tokensOwed0).to.eq(24)
      expect(tokensOwed1).to.eq(24)
    })

    it('gas partial decrease', async () => {
      await snapshotGasCost(nft.connect(other).decreaseLiquidity(tokenId, 50, 0, 0, 1))
    })

    it('gas complete decrease', async () => {
      await snapshotGasCost(nft.connect(other).decreaseLiquidity(tokenId, 100, 0, 0, 1))
    })
  })

  describe('#collect', () => {
    const tokenId = 1
    beforeEach('create a position', async () => {
      await nft.firstMint({
        token0: tokens[0].address,
        token1: tokens[1].address,
        sqrtPriceX96: encodePriceSqrt(1, 1),
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        recipient: other.address,
        amount: 100,
        deadline: 1,
        fee: FeeAmount.MEDIUM,
      })
    })

    it('cannot be called by other addresses', async () => {
      await expect(nft.collect(tokenId, wallet.address, MaxUint128, MaxUint128)).to.be.revertedWith('Not approved')
    })

    it('cannot be called with 0 amounts', async () => {
      await expect(nft.connect(other).collect(tokenId, wallet.address, 0, 0)).to.be.reverted
    })

    it('no op if no tokens are owed', async () => {
      await expect(nft.connect(other).collect(tokenId, wallet.address, MaxUint128, MaxUint128))
        .to.not.emit(tokens[0], 'Transfer')
        .to.not.emit(tokens[1], 'Transfer')
    })

    it('transfers tokens owed from burn', async () => {
      await nft.connect(other).decreaseLiquidity(tokenId, 50, 0, 0, 1)
      const poolAddress = computePoolAddress(factory.address, [tokens[0].address, tokens[1].address], FeeAmount.MEDIUM)
      await expect(nft.connect(other).collect(tokenId, wallet.address, MaxUint128, MaxUint128))
        .to.emit(tokens[0], 'Transfer')
        .withArgs(poolAddress, wallet.address, 49)
        .to.emit(tokens[1], 'Transfer')
        .withArgs(poolAddress, wallet.address, 49)
    })

    it('gas transfers both', async () => {
      await nft.connect(other).decreaseLiquidity(tokenId, 50, 0, 0, 1)
      await snapshotGasCost(nft.connect(other).collect(tokenId, wallet.address, MaxUint128, MaxUint128))
    })

    it('gas transfers token0 only', async () => {
      await nft.connect(other).decreaseLiquidity(tokenId, 50, 0, 0, 1)
      await snapshotGasCost(nft.connect(other).collect(tokenId, wallet.address, MaxUint128, 0))
    })

    it('gas transfers token1 only', async () => {
      await nft.connect(other).decreaseLiquidity(tokenId, 50, 0, 0, 1)
      await snapshotGasCost(nft.connect(other).collect(tokenId, wallet.address, 0, MaxUint128))
    })
  })

  describe('#burn', () => {
    const tokenId = 1
    beforeEach('create a position', async () => {
      await nft.firstMint({
        token0: tokens[0].address,
        token1: tokens[1].address,
        sqrtPriceX96: encodePriceSqrt(1, 1),
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        recipient: other.address,
        amount: 100,
        deadline: 1,
        fee: FeeAmount.MEDIUM,
      })
    })

    it('cannot be called by other addresses', async () => {
      await expect(nft.burn(tokenId)).to.be.revertedWith('Not approved')
    })

    it('cannot be called while there is still liquidity', async () => {
      await expect(nft.connect(other).burn(tokenId)).to.be.revertedWith('Not cleared')
    })

    it('cannot be called while there is still partial liquidity', async () => {
      await nft.connect(other).decreaseLiquidity(tokenId, 50, 0, 0, 1)
      await expect(nft.connect(other).burn(tokenId)).to.be.revertedWith('Not cleared')
    })

    it('cannot be called while there is still tokens owed', async () => {
      await nft.connect(other).decreaseLiquidity(tokenId, 100, 0, 0, 1)
      await expect(nft.connect(other).burn(tokenId)).to.be.revertedWith('Not cleared')
    })

    it('deletes the token', async () => {
      await nft.connect(other).decreaseLiquidity(tokenId, 100, 0, 0, 1)
      await nft.connect(other).collect(tokenId, wallet.address, MaxUint128, MaxUint128)
      await nft.connect(other).burn(tokenId)
      const { liquidity, token0, token1, fee, tokensOwed0, tokensOwed1 } = await nft.positions(tokenId)
      expect(token0).to.eq(constants.AddressZero)
      expect(token1).to.eq(constants.AddressZero)
      expect(fee).to.eq(fee)
      expect(liquidity).to.eq(0)
      expect(tokensOwed0).to.eq(0)
      expect(tokensOwed1).to.eq(0)
    })

    it('gas', async () => {
      await nft.connect(other).decreaseLiquidity(tokenId, 100, 0, 0, 1)
      await nft.connect(other).collect(tokenId, wallet.address, MaxUint128, MaxUint128)
      await snapshotGasCost(nft.connect(other).burn(tokenId))
    })
  })

  describe('#transferFrom', () => {
    const tokenId = 1
    beforeEach('create a position', async () => {
      await nft.firstMint({
        token0: tokens[0].address,
        token1: tokens[1].address,
        sqrtPriceX96: encodePriceSqrt(1, 1),
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        recipient: other.address,
        amount: 100,
        deadline: 1,
        fee: FeeAmount.MEDIUM,
      })
    })

    it('can only be called by authorized or owner', async () => {
      await expect(nft.transferFrom(other.address, wallet.address, tokenId)).to.be.revertedWith(
        'ERC721: transfer caller is not owner nor approved'
      )
    })

    it('changes the owner', async () => {
      await nft.connect(other).transferFrom(other.address, wallet.address, tokenId)
      expect(await nft.ownerOf(tokenId)).to.eq(wallet.address)
    })

    it('removes existing approval', async () => {
      await nft.connect(other).approve(wallet.address, tokenId)
      expect(await nft.getApproved(tokenId)).to.eq(wallet.address)
      await nft.transferFrom(other.address, wallet.address, tokenId)
      expect(await nft.getApproved(tokenId)).to.eq(constants.AddressZero)
    })

    it('gas', async () => {
      await snapshotGasCost(nft.connect(other).transferFrom(other.address, wallet.address, tokenId))
    })

    it('gas comes from approved', async () => {
      await nft.connect(other).approve(wallet.address, tokenId)
      await snapshotGasCost(nft.transferFrom(other.address, wallet.address, tokenId))
    })
  })

  describe('#permit', () => {
    describe('owned by eoa', () => {
      const tokenId = 1
      beforeEach('create a position', async () => {
        await nft.firstMint({
          token0: tokens[0].address,
          token1: tokens[1].address,
          sqrtPriceX96: encodePriceSqrt(1, 1),
          tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          recipient: other.address,
          amount: 100,
          deadline: 1,
          fee: FeeAmount.MEDIUM,
        })
      })

      it('changes the operator of the position and increments the nonce', async () => {
        const { v, r, s } = await getPermitNFTSignature(other, nft, wallet.address, tokenId, 1)
        await nft.permit(wallet.address, tokenId, 1, v, r, s)
        expect((await nft.positions(tokenId)).nonce).to.eq(1)
        expect((await nft.positions(tokenId)).operator).to.eq(wallet.address)
      })

      it('cannot be called twice with the same signature', async () => {
        const { v, r, s } = await getPermitNFTSignature(other, nft, wallet.address, tokenId, 1)
        await nft.permit(wallet.address, tokenId, 1, v, r, s)
        await expect(nft.permit(wallet.address, tokenId, 1, v, r, s)).to.be.reverted
      })

      it('fails with signature not from owner', async () => {
        const { v, r, s } = await getPermitNFTSignature(wallet, nft, wallet.address, tokenId, 1)
        await expect(nft.permit(wallet.address, tokenId, 1, v, r, s)).to.be.revertedWith('Invalid signature')
      })

      it('fails with expired signature', async () => {
        await nft.setTime(2)
        const { v, r, s } = await getPermitNFTSignature(other, nft, wallet.address, tokenId, 1)
        await expect(nft.permit(wallet.address, tokenId, 1, v, r, s)).to.be.revertedWith('Permit expired')
      })

      it('gas', async () => {
        const { v, r, s } = await getPermitNFTSignature(other, nft, wallet.address, tokenId, 1)
        await snapshotGasCost(nft.permit(wallet.address, tokenId, 1, v, r, s))
      })
    })
    describe('owned by verifying contract', () => {
      const tokenId = 1
      let testPositionNFTOwner: TestPositionNFTOwner

      beforeEach('deploy test owner and create a position', async () => {
        testPositionNFTOwner = (await (
          await ethers.getContractFactory('TestPositionNFTOwner')
        ).deploy()) as TestPositionNFTOwner

        await nft.firstMint({
          token0: tokens[0].address,
          token1: tokens[1].address,
          sqrtPriceX96: encodePriceSqrt(1, 1),
          tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          recipient: testPositionNFTOwner.address,
          amount: 100,
          deadline: 1,
          fee: FeeAmount.MEDIUM,
        })
      })

      it('changes the operator of the position and increments the nonce', async () => {
        const { v, r, s } = await getPermitNFTSignature(other, nft, wallet.address, tokenId, 1)
        await testPositionNFTOwner.setOwner(other.address)
        await nft.permit(wallet.address, tokenId, 1, v, r, s)
        expect((await nft.positions(tokenId)).nonce).to.eq(1)
        expect((await nft.positions(tokenId)).operator).to.eq(wallet.address)
      })

      it('fails if owner contract is owned by different address', async () => {
        const { v, r, s } = await getPermitNFTSignature(other, nft, wallet.address, tokenId, 1)
        await testPositionNFTOwner.setOwner(wallet.address)
        await expect(nft.permit(wallet.address, tokenId, 1, v, r, s)).to.be.revertedWith('Invalid signature')
      })

      it('fails with signature not from owner', async () => {
        const { v, r, s } = await getPermitNFTSignature(wallet, nft, wallet.address, tokenId, 1)
        await testPositionNFTOwner.setOwner(other.address)
        await expect(nft.permit(wallet.address, tokenId, 1, v, r, s)).to.be.revertedWith('Invalid signature')
      })

      it('fails with expired signature', async () => {
        await nft.setTime(2)
        const { v, r, s } = await getPermitNFTSignature(other, nft, wallet.address, tokenId, 1)
        await testPositionNFTOwner.setOwner(other.address)
        await expect(nft.permit(wallet.address, tokenId, 1, v, r, s)).to.be.revertedWith('Permit expired')
      })

      it('gas', async () => {
        const { v, r, s } = await getPermitNFTSignature(other, nft, wallet.address, tokenId, 1)
        await testPositionNFTOwner.setOwner(other.address)
        await snapshotGasCost(nft.permit(wallet.address, tokenId, 1, v, r, s))
      })
    })
  })

  describe('multicall exit', () => {
    const tokenId = 1
    beforeEach('create a position', async () => {
      await nft.firstMint({
        token0: tokens[0].address,
        token1: tokens[1].address,
        sqrtPriceX96: encodePriceSqrt(1, 1),
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        recipient: other.address,
        amount: 100,
        deadline: 1,
        fee: FeeAmount.MEDIUM,
      })
    })

    async function exit({
      nft,
      liquidity,
      tokenId,
      amount0Min,
      amount1Min,
      recipient,
    }: {
      nft: MockTimeNonfungiblePositionManager
      tokenId: BigNumberish
      liquidity: BigNumberish
      amount0Min: BigNumberish
      amount1Min: BigNumberish
      recipient: string
    }) {
      const decreaseLiquidityData = nft.interface.encodeFunctionData('decreaseLiquidity', [
        tokenId,
        liquidity,
        amount0Min,
        amount1Min,
        /*deadline=*/ 1,
      ])
      const collectData = nft.interface.encodeFunctionData('collect', [tokenId, recipient, MaxUint128, MaxUint128])
      const burnData = nft.interface.encodeFunctionData('burn', [tokenId])

      return nft.multicall([decreaseLiquidityData, collectData, burnData])
    }

    it('executes all the actions', async () => {
      const pool = poolAtAddress(
        computePoolAddress(factory.address, [tokens[0].address, tokens[1].address], FeeAmount.MEDIUM),
        wallet
      )
      await expect(
        exit({
          nft: nft.connect(other),
          tokenId,
          liquidity: 100,
          amount0Min: 0,
          amount1Min: 0,
          recipient: wallet.address,
        })
      )
        .to.emit(pool, 'Burn')
        .to.emit(pool, 'Collect')
    })

    it('gas', async () => {
      await snapshotGasCost(
        exit({
          nft: nft.connect(other),
          tokenId,
          liquidity: 100,
          amount0Min: 0,
          amount1Min: 0,
          recipient: wallet.address,
        })
      )
    })
  })

  describe('#tokenURI', async () => {
    const tokenId = 1
    beforeEach('create a position', async () => {
      await nft.firstMint({
        token0: tokens[0].address,
        token1: tokens[1].address,
        sqrtPriceX96: encodePriceSqrt(1, 1),
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        recipient: other.address,
        amount: 100,
        deadline: 1,
        fee: FeeAmount.MEDIUM,
      })
    })

    it('reverts for invalid token id', async () => {
      await expect(nft.tokenURI(tokenId + 1)).to.be.reverted
    })

    it('returns a data URI with correct mime type', async () => {
      expect(await nft.tokenURI(tokenId)).to.match(/data:application\/json,.+/)
    })

    it('content is valid JSON and structure', async () => {
      const content = JSON.parse((await nft.tokenURI(tokenId)).substr('data:application/json,'.length))
      expect(content).to.haveOwnProperty('name').is.a('string')
      expect(content).to.haveOwnProperty('description').is.a('string')
    })
  })
})
